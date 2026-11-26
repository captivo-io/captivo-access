import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/current-user";
import { can } from "@/lib/auth/roles";
import { db } from "@/lib/db";
import { recordAdminAction } from "@/lib/audit/admin";
import { clientIp } from "@/lib/request-ip";
import { withTenantRoute } from "@/lib/tenant/request";
import { SLOW_SCOPE_BUDGET_MS } from "@/lib/tenant/scope";
import { validateProfile, type ProfileSettings } from "@/lib/policy/profiles";
import { reapplyProfile } from "@/lib/policy/profile-store";

export const dynamic = "force-dynamic";

export const PATCH = withTenantRoute(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const admin = await getCurrentUser();
  if (!admin) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!can(admin.role, "configure")) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { id } = await ctx.params;
  const cur = await db.policyProfile.findUnique({ where: { id } });
  if (!cur) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const v = validateProfile((await req.json().catch(() => ({}))) as Record<string, unknown>, cur as ProfileSettings & { name: string; description: string | null });
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 });
  if (await db.policyProfile.findFirst({ where: { id: { not: id }, name: { equals: v.value.name, mode: "insensitive" } }, select: { id: true } })) return NextResponse.json({ error: "name_taken" }, { status: 409 });
  if (v.value.commandListId && !(await db.commandList.findUnique({ where: { id: v.value.commandListId }, select: { id: true } }))) return NextResponse.json({ error: "unknown_command_list" }, { status: 400 });
  await db.policyProfile.update({ where: { id }, data: v.value });
  // The resources that follow it take the new settings now.
  const resources = await reapplyProfile(id);
  await recordAdminAction({
    actor: { id: admin.id, email: admin.email }, action: "policy_profile.update", targetType: "policy_profile", targetId: id,
    summary: `Updated policy profile "${v.value.name}"; ${resources} ${resources === 1 ? "resource follows" : "resources follow"} it${resources ? " and took the new settings (open sessions keep theirs)" : ""}`,
    metadata: { resources }, clientIp: clientIp(req.headers) ?? null,
  });
  return NextResponse.json({ ok: true, resources });
}, { budgetMs: SLOW_SCOPE_BUDGET_MS });

export const DELETE = withTenantRoute(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const admin = await getCurrentUser();
  if (!admin) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!can(admin.role, "configure")) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { id } = await ctx.params;
  const cur = await db.policyProfile.findUnique({ where: { id }, include: { _count: { select: { sites: true } } } });
  if (!cur) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (cur._count.sites > 0) return NextResponse.json({ error: "in_use", resources: cur._count.sites }, { status: 409 });
  await db.policyProfile.delete({ where: { id } });
  await recordAdminAction({
    actor: { id: admin.id, email: admin.email }, action: "policy_profile.delete", targetType: "policy_profile", targetId: id,
    summary: `Deleted policy profile "${cur.name}"`, clientIp: clientIp(req.headers) ?? null,
  });
  return NextResponse.json({ ok: true });
});
