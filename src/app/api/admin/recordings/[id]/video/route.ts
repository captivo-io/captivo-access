import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/current-user";
import { can } from "@/lib/auth/roles";
import { db } from "@/lib/db";
import { fetchFromHolders, isFailure } from "@/lib/recording/holders";
import { withTenantRoute } from "@/lib/tenant/request";
import { SLOW_SCOPE_BUDGET_MS } from "@/lib/tenant/scope";
import { parseVideoRange } from "@/lib/recording/video-range";

export const runtime = "nodejs";

export const dynamic = "force-dynamic";

/**
 * Serve a recording's video from the connector that holds it: an isolated-browser
 * session, or an RDP/VNC session its connector has turned into video.
 *
 * Range is passed THROUGH to the connector rather than answered here: the recording
 * is never in the control plane, and buffering it to satisfy a Range would mean
 * holding up to the 500 MiB cap in memory for a copy this design removes. The
 * connector slices across its own chunks and reports the total.
 */
export const GET = withTenantRoute(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const admin = await getCurrentUser();
  if (!admin) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!can(admin.role, "configure")) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const { id } = await params;
  const rec = await db.sessionRecording.findUnique({ where: { id } });
  // An isolated-browser recording is video from the start; an RDP/VNC one once
  // its connector has converted it (both stored as the "video" stream).
  if (!rec || !(rec.format === "VIDEO" || ((rec.format === "GUAC" || rec.format === "RDP") && rec.videoReady))) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  // At most MAX_RANGE_BYTES per answer: see lib/recording/video-range.ts.
  const { wantsRange, fromByte, toByte } = parseVideoRange(req.headers.get("range"));

  // The original holder first; a copy on another member of its group when the original cannot answer.
  const fetched = await fetchFromHolders(rec, "video", { fromByte, toByte });
  if (isFailure(fetched)) {
    return NextResponse.json(
      fetched.error === "no_connector"
        ? { error: "no_connector", detail: "this recording's site has no connector, so its bytes cannot be reached" }
        : { error: "connector_offline", detail: "the connector holding this recording is offline; the recording is intact but unreachable" },
      { status: 503 }
    );
  }
  const got = fetched.got;

  const headers = new Headers({
    "Content-Type": "video/webm",
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, no-store",
  });
  if (wantsRange && got.totalBytes > 0) {
    const end = Math.min(toByte, got.totalBytes - 1);
    headers.set("Content-Range", `bytes ${fromByte}-${end}/${got.totalBytes}`);
    headers.set("Content-Length", String(end - fromByte + 1));
    return new NextResponse(got.body, { status: 206, headers });
  }
  if (got.totalBytes > 0) headers.set("Content-Length", String(got.totalBytes));
  return new NextResponse(got.body, { status: 200, headers });
}, { budgetMs: SLOW_SCOPE_BUDGET_MS });
