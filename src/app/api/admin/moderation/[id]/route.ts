import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/current-user";
import { db } from "@/lib/db";
import { listActiveSessions } from "@/lib/dataplane/client";
import { decideRequest } from "@/lib/moderation/requests";
import { statusOf } from "@/lib/moderation/rules";
import { recordAdminAction } from "@/lib/audit/admin";
import { clientIp } from "@/lib/request-ip";
import { withTenantRoute } from "@/lib/tenant/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ERRORS = { not_found: 404, not_moderator: 403, own_session: 403, not_waiting: 409 } as const;

/** Admit or decline a waiting request: { action: "admit" | "decline" }. */
export const POST = withTenantRoute(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as { action?: unknown };
  const admit = body.action !== "decline";
  const r = await decideRequest(id, user, admit);
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: ERRORS[r.error] });
  const [who, site] = await Promise.all([
    db.user.findUnique({ where: { id: r.userId }, select: { email: true } }),
    db.site.findUnique({ where: { id: r.siteId }, select: { name: true } }),
  ]);
  await recordAdminAction({
    actor: { id: user.id, email: user.email },
    action: admit ? "session.moderate" : "session.moderate_decline",
    targetType: "resource", targetId: r.siteId,
    summary: admit ? `Admitted ${who?.email ?? "a user"}'s session on "${site?.name ?? r.siteId}" as moderator` : `Declined ${who?.email ?? "a user"}'s request for a moderator on "${site?.name ?? r.siteId}"`,
    clientIp: clientIp(req.headers) ?? null,
  });
  return NextResponse.json({ ok: true });
});

/** Where the request stands, and its live session once it started (the console opens it to watch). */
export const GET = withTenantRoute(async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const r = await db.moderationRequest.findUnique({ where: { id } });
  if (!r || r.moderatorId !== user.id) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const status = statusOf(r, new Date());
  const session = status === "started" ? (await listActiveSessions()).find((s) => s.moderation?.id === id) : undefined;
  return NextResponse.json({ status, sessionId: session?.sessionId ?? null }, { headers: { "cache-control": "no-store" } });
});
