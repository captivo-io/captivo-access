import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/current-user";
import { can } from "@/lib/auth/roles";
import { db } from "@/lib/db";
import { currentTenantId } from "@/lib/tenant/context";
import { connectorForRecording } from "@/lib/recording/connector-of";
import { fetchFromConnector } from "@/lib/dataplane/recordings";
import { assembleEvents } from "@/lib/recording/assemble";
import { withTenantRoute } from "@/lib/tenant/request";

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

  const connectorId = await connectorForRecording(rec.siteId);
  if (!connectorId) {
    return NextResponse.json(
      { error: "no_connector", detail: "this recording's site has no connector, so its bytes cannot be reached" },
      { status: 503 }
    );
  }

  const got = await fetchFromConnector({
    connectorId,
    tenantId: currentTenantId(),
    recordingKey: rec.recordingKey,
  });
  if (!got) {
    return NextResponse.json(
      { error: "connector_offline", detail: "the connector holding this recording is offline; the recording is intact but unreachable" },
      { status: 503 }
    );
  }

  const raw = Buffer.from(await new Response(got.body).arrayBuffer());
  // The connector already decrypted and ordered the chunks, so what arrives is the
  // concatenated plaintext of the rrweb batches.
  const events = assembleEvents(raw);

  return NextResponse.json({ id: rec.id, startedAt: rec.startedAt, events });
});
