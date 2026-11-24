import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/current-user";
import { db } from "@/lib/db";
import { findOwnSession, setSessionModerator } from "@/lib/dataplane/client";
import { canModerate } from "@/lib/moderation/rules";
import { resolvedModeratorRoles } from "@/lib/settings/platform";
import { recordAdminAction } from "@/lib/audit/admin";
import { clientIp } from "@/lib/request-ip";
import { withTenantRoute } from "@/lib/tenant/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Become the moderator of a running moderated session, as when the one before
 * left: the user's input passes again once this person watches it.
 */
export const POST = withTenantRoute(async (req: Request, { params }: { params: Promise<{ sessionId: string }> }) => {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!canModerate(user.role, await resolvedModeratorRoles())) return NextResponse.json({ error: "not_moderator" }, { status: 403 });
  const { sessionId } = await params;
  const s = await findOwnSession(sessionId);
  if (!s?.moderation) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (s.userId === user.id) return NextResponse.json({ error: "own_session" }, { status: 403 });
  if (s.moderation.moderatorId !== user.id) {
    if (!(await setSessionModerator(sessionId, user.id))) return NextResponse.json({ error: "not_delivered" }, { status: 502 });
    await db.moderationRequest.updateMany({ where: { id: s.moderation.id }, data: { moderatorId: user.id, moderatorEmail: user.email } });
    const [who, site] = await Promise.all([
      db.user.findUnique({ where: { id: s.userId }, select: { email: true } }),
      db.site.findUnique({ where: { id: s.siteId }, select: { name: true } }),
    ]);
    await recordAdminAction({
      actor: { id: user.id, email: user.email },
      action: "session.moderate_takeover",
      targetType: "resource", targetId: s.siteId,
      summary: `Took over as moderator of ${who?.email ?? "a user"}'s session on "${site?.name ?? s.siteId}"`,
      clientIp: clientIp(req.headers) ?? null,
    });
  }
  return NextResponse.json({ ok: true });
});
