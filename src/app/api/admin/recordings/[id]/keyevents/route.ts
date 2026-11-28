import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/current-user";
import { can } from "@/lib/auth/roles";
import { db } from "@/lib/db";
import { fetchFromHolders, isFailure } from "@/lib/recording/holders";
import { assembleKeyEvents } from "@/lib/recording/assemble-keys";
import { withTenantRoute } from "@/lib/tenant/request";
import { SLOW_SCOPE_BUDGET_MS } from "@/lib/tenant/scope";

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
    select: { id: true, recordingKey: true, siteId: true, connectorId: true, protocol: true, format: true },
  });
  if (!rec) return NextResponse.json({ error: "not_found" }, { status: 404 });

  // The original holder first; a copy on another member of its group when the original cannot answer.
  const fetched = await fetchFromHolders(rec, "keys");
  if (isFailure(fetched)) {
    return NextResponse.json(
      fetched.error === "no_connector"
        ? { error: "no_connector", detail: "this recording's site has no connector, so its keystroke timeline cannot be reached" }
        : { error: "connector_offline", detail: "the connector holding this recording is offline; the timeline is intact but unreachable" },
      { status: 503 }
    );
  }
  const got = fetched.got;

  const raw = Buffer.from(await new Response(got.body).arrayBuffer());
  return NextResponse.json(assembleKeyEvents(raw));
}, { budgetMs: SLOW_SCOPE_BUDGET_MS });
