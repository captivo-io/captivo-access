import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/current-user";
import { can } from "@/lib/auth/roles";
import { db } from "@/lib/db";
import { recordAdminAction } from "@/lib/audit/admin";
import { clientIp } from "@/lib/request-ip";
import { withTenantRoute } from "@/lib/tenant/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Revokes an agent token: the token stops working at once, and the access
// its identity holds is ended (the data plane rechecks live sessions every
// minute and cuts them).
export const DELETE = withTenantRoute(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const u = await getCurrentUser();
  if (!u) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!can(u.role, "configure")) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { id } = await params;
  const t = await db.apiToken.findUnique({ where: { id }, select: { id: true, name: true, userId: true, revokedAt: true } });
  if (!t) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const now = new Date();
  const ended = await db.$transaction(async (tx) => {
    if (!t.revokedAt) await tx.apiToken.update({ where: { id }, data: { revokedAt: now } });
    const g = await tx.accessGrant.updateMany({
      where: { userId: t.userId, status: "ACTIVE" },
      data: { status: "REVOKED", revokedAt: now, revokedById: u.id, revokeReason: `agent token "${t.name}" revoked` },
    });
    return g.count;
  });
  await recordAdminAction({
    actor: { id: u.id, email: u.email }, action: "agent.token_revoke", targetType: "agent", targetId: id,
    summary: `Revoked the agent token "${t.name}"${ended ? ` and ended ${ended} access grant${ended === 1 ? "" : "s"}` : ""}`,
    clientIp: clientIp(req.headers) ?? null,
  });
  return NextResponse.json({ ok: true, ended });
});
