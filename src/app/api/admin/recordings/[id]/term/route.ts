import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/current-user";
import { can } from "@/lib/auth/roles";
import { db } from "@/lib/db";
import { fetchFromHolders, isFailure } from "@/lib/recording/holders";
import { withTenantRoute } from "@/lib/tenant/request";
import { SLOW_SCOPE_BUDGET_MS } from "@/lib/tenant/scope";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Stream a recorded native SSH session (asciicast lines) from the connector that holds it.
 *
 * The connector returns the lines already decrypted and in chunk order,
 * so there is nothing to assemble here -- the player reads it as one stream. An
 * offline connector is 503 with a reason, never an empty 200, because an empty
 * recording plays as a blank session rather than an unavailable one.
 */
export const GET = withTenantRoute(async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const admin = await getCurrentUser();
  if (!admin) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!can(admin.role, "configure")) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const { id } = await params;
  const rec = await db.sessionRecording.findUnique({ where: { id } });
  if (!rec || rec.format !== "TERM") return NextResponse.json({ error: "not_found" }, { status: 404 });

  // The original holder first; a copy on another member of its group when the original cannot answer.
  const fetched = await fetchFromHolders(rec, "term");
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
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
  });
  if (got.totalBytes > 0) headers.set("Content-Length", String(got.totalBytes));
  return new NextResponse(got.body, { status: 200, headers });
}, { budgetMs: SLOW_SCOPE_BUDGET_MS });
