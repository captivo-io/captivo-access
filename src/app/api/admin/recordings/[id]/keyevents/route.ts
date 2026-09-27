import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/current-user";
import { can } from "@/lib/auth/roles";
import { db } from "@/lib/db";
import { currentTenantId } from "@/lib/tenant/context";
import { connectorForRecording } from "@/lib/recording/connector-of";
import { fetchFromConnector } from "@/lib/dataplane/recordings";
import { assembleKeyEvents } from "@/lib/recording/assemble-keys";
import { withTenantRoute } from "@/lib/tenant/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The keystroke timeline a player seeks by.
 *
 * Keystroke events moved to the connector with the recordings, so this reads them
 * from there. It used to decrypt SessionKeyEvent rows centrally; leaving it that way
 * would have returned an empty timeline forever -- a feature silently doing nothing,
 * which is the failure mode this whole change keeps producing and the reason every
 * unreachable case below answers with a status rather than an empty list.
 *
 * Masked entries keep their text hidden here exactly as before: a masked line is a
 * password prompt, and the player shows dots.
 */
export const GET = withTenantRoute(async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const admin = await getCurrentUser();
  if (!admin) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!can(admin.role, "configure")) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const { id } = await params;
  const rec = await db.sessionRecording.findUnique({
    where: { id },
    select: { recordingKey: true, siteId: true },
  });
  if (!rec) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const connectorId = await connectorForRecording(rec.siteId);
  if (!connectorId) {
    return NextResponse.json(
      { error: "no_connector", detail: "this recording's site has no connector, so its keystroke timeline cannot be reached" },
      { status: 503 }
    );
  }

  const got = await fetchFromConnector({
    format: "keys",
    connectorId,
    tenantId: currentTenantId(),
    recordingKey: rec.recordingKey,
  });
  if (!got) {
    return NextResponse.json(
      { error: "connector_offline", detail: "the connector holding this recording is offline; the timeline is intact but unreachable" },
      { status: 503 }
    );
  }

  const raw = Buffer.from(await new Response(got.body).arrayBuffer());
  return NextResponse.json(assembleKeyEvents(raw));
});
