import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/current-user";
import { can } from "@/lib/auth/roles";
import { db } from "@/lib/db";
import { parseGroupInput } from "@/lib/connector/groups";
import { GroupSaveError, saveConnectorGroup } from "@/lib/connector/group-save";
import { recordAdminAction } from "@/lib/audit/admin";
import { clientIp } from "@/lib/request-ip";
import { withTenantRoute } from "@/lib/tenant/request";
import { SLOW_SCOPE_BUDGET_MS } from "@/lib/tenant/scope";
import { reshareGroupSecrets } from "@/lib/vault/reshare";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export const PATCH = withTenantRoute(async (req: NextRequest, ctx: Ctx) => {
  const admin = await getCurrentUser();
  if (!admin) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!can(admin.role, "configure")) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { id } = await ctx.params;
  const existing = await db.connectorGroup.findUnique({ where: { id }, select: { id: true } });
  if (!existing) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const input = parseGroupInput(await req.json().catch(() => null));
  if ("error" in input) return NextResponse.json({ error: input.error }, { status: 400 });
  try {
    await saveConnectorGroup(id, input.name, input.members);
  } catch (e) {
    if (e instanceof GroupSaveError) return NextResponse.json({ error: e.message }, { status: e.message === "name_taken" ? 409 : 400 });
    throw e;
  }
  const active = input.members.filter((m) => !m.standby).length;
  await recordAdminAction({
    actor: { id: admin.id, email: admin.email },
    action: "connector.group_update", targetType: "connector_group", targetId: id,
    summary: `Updated connector group "${input.name}": ${active} active, ${input.members.length - active} standby`,
    clientIp: clientIp(req.headers) ?? null,
  });
  // A member that just joined gets copies of the saved passwords from one that has them.
  await reshareGroupSecrets({ groupIds: [id] }, { id: admin.id, email: admin.email }).catch((e) => console.error("vault: copying secrets to the group failed", e));
  return NextResponse.json({ ok: true });
}, { budgetMs: SLOW_SCOPE_BUDGET_MS });

// A group still serving resources is not deleted: they would have nowhere to
// go. Move them to a connector or another group first.
export const DELETE = withTenantRoute(async (req: NextRequest, ctx: Ctx) => {
  const admin = await getCurrentUser();
  if (!admin) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!can(admin.role, "configure")) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { id } = await ctx.params;
  const g = await db.connectorGroup.findUnique({ where: { id }, select: { id: true, name: true, _count: { select: { sites: true } } } });
  if (!g) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (g._count.sites > 0) return NextResponse.json({ error: "group_in_use", resources: g._count.sites }, { status: 409 });
  await db.connectorGroup.delete({ where: { id } });
  await recordAdminAction({
    actor: { id: admin.id, email: admin.email },
    action: "connector.group_delete", targetType: "connector_group", targetId: id,
    summary: `Deleted connector group "${g.name}"`,
    clientIp: clientIp(req.headers) ?? null,
  });
  return NextResponse.json({ ok: true });
});
