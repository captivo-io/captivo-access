import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/current-user";
import { can } from "@/lib/auth/roles";
import { db } from "@/lib/db";
import { currentTenantId } from "@/lib/tenant/context";
import { connectorForRecording } from "@/lib/recording/connector-of";
import { fetchFromConnector } from "@/lib/dataplane/recordings";
import { withTenantRoute } from "@/lib/tenant/request";
import { SLOW_SCOPE_BUDGET_MS } from "@/lib/tenant/scope";
import { parseVideoRange } from "@/lib/recording/video-range";

export const runtime = "nodejs";

export const dynamic = "force-dynamic";

/**
 * Serve an isolated-browser video from the connector that holds it.
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
  if (!rec || rec.format !== "VIDEO") return NextResponse.json({ error: "not_found" }, { status: 404 });

  const connectorId = await connectorForRecording(rec.siteId);
  if (!connectorId) {
    return NextResponse.json(
      { error: "no_connector", detail: "this recording's site has no connector, so its bytes cannot be reached" },
      { status: 503 }
    );
  }

  // At most MAX_RANGE_BYTES per answer: see lib/recording/video-range.ts.
  const { wantsRange, fromByte, toByte } = parseVideoRange(req.headers.get("range"));

  const got = await fetchFromConnector({
    format: "video",
    connectorId,
    tenantId: currentTenantId(),
    recordingKey: rec.recordingKey,
    fromByte,
    toByte,
  });
  if (!got) {
    return NextResponse.json(
      { error: "connector_offline", detail: "the connector holding this recording is offline; the recording is intact but unreachable" },
      { status: 503 }
    );
  }

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
