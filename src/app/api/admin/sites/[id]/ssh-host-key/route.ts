import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/current-user";
import { can } from "@/lib/auth/roles";
import { db } from "@/lib/db";
import { recordAdminAction } from "@/lib/audit/admin";
import { clientIp } from "@/lib/request-ip";
import { withTenantRoute } from "@/lib/tenant/request";

export const runtime = "nodejs";

/**
 * Forgets the SSH host key kept for a resource's server (VaultCredential.sshHostKey),
 * after the server was rebuilt or its key replaced on purpose. The next recorded
 * session or password rotation takes whatever key the server shows then.
 */
export const DELETE = withTenantRoute(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const admin = await getCurrentUser();
  if (!admin) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!can(admin.role, "configure")) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { id } = await ctx.params;
  const cred = await db.vaultCredential.findUnique({ where: { siteId: id }, select: { sshHostKey: true, site: { select: { name: true } } } });
  if (!cred) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (!cred.sshHostKey) return NextResponse.json({ ok: true });
  await db.vaultCredential.update({ where: { siteId: id }, data: { sshHostKey: null } });
  await recordAdminAction({
    actor: { id: admin.id, email: admin.email },
    action: "site.ssh_host_key_forget",
    targetType: "site", targetId: id,
    summary: `Forgot the SSH host key kept for ${cred.site.name} (${cred.sshHostKey}); the next connection takes the key the server shows`,
    clientIp: clientIp(req.headers) ?? null,
  });
  return NextResponse.json({ ok: true });
});
