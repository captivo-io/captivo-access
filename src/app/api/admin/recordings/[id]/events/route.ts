import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/current-user";
import { can } from "@/lib/auth/roles";
import { db } from "@/lib/db";
import { fetchFromHolders, isFailure } from "@/lib/recording/holders";
import { assembleEvents } from "@/lib/recording/assemble";
import { withTenantRoute } from "@/lib/tenant/request";
import { SLOW_SCOPE_BUDGET_MS } from "@/lib/tenant/scope";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Replay an rrweb recording by streaming it from the connector that holds it.
 *
 * The control plane keeps no copy, so an offline connector is answered with 503 and
 * a named reason -- never an empty 200. An empty event list renders as "the session
 * happened and nothing was captured", which is a different and wrong claim.
 */
export const GET = withTenantRoute(async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const admin = await getCurrentUser();
  if (!admin) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!can(admin.role, "configure")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const { id } = await params;
  const rec = await db.sessionRecording.findUnique({ where: { id } });
  if (!rec) return NextResponse.json({ error: "not_found" }, { status: 404 });

  // The original holder first; a copy on another member of its group when the original cannot answer.
  const fetched = await fetchFromHolders(rec, "rrweb");
  if (isFailure(fetched)) {
    return NextResponse.json(
      fetched.error === "no_connector"
        ? { error: "no_connector", detail: "this recording's site has no connector, so its bytes cannot be reached" }
        : { error: "connector_offline", detail: "the connector holding this recording is offline; the recording is intact but unreachable" },
      { status: 503 }
    );
  }
  const got = fetched.got;

  const raw = Buffer.from(await new Response(got.body).arrayBuffer());
  // The connector already decrypted and ordered the chunks, so what arrives is the
  // concatenated plaintext of the rrweb batches.
  const events = assembleEvents(raw);

  return NextResponse.json({ id: rec.id, startedAt: rec.startedAt, events });
}, { budgetMs: SLOW_SCOPE_BUDGET_MS });
