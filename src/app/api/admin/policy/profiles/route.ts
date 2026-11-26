import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/current-user";
import { can } from "@/lib/auth/roles";
import { db } from "@/lib/db";
import { recordAdminAction } from "@/lib/audit/admin";
import { clientIp } from "@/lib/request-ip";
import { withTenantRoute } from "@/lib/tenant/request";
import { MAX_PROFILES, validateProfile } from "@/lib/policy/profiles";

export const dynamic = "force-dynamic";

export const GET = withTenantRoute(async () => {
  const admin = await getCurrentUser();
  if (!admin) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!can(admin.role, "read_console")) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const profiles = await db.policyProfile.findMany({ orderBy: { name: "asc" }, include: { _count: { select: { sites: true } } } });
  return NextResponse.json({ profiles: profiles.map(({ _count, createdAt, updatedAt, ...p }) => ({ ...p, tenantId: undefined, resources: _count.sites, createdAt: createdAt.toISOString(), updatedAt: updatedAt.toISOString() })) });
});

export const POST = withTenantRoute(async (req: NextRequest) => {
  const admin = await getCurrentUser();
  if (!admin) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!can(admin.role, "configure")) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const v = validateProfile((await req.json().catch(() => ({}))) as Record<string, unknown>);
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 });
  if ((await db.policyProfile.count()) >= MAX_PROFILES) return NextResponse.json({ error: "too_many_profiles" }, { status: 409 });
  if (await db.policyProfile.findFirst({ where: { name: { equals: v.value.name, mode: "insensitive" } }, select: { id: true } })) return NextResponse.json({ error: "name_taken" }, { status: 409 });
  if (v.value.commandListId && !(await db.commandList.findUnique({ where: { id: v.value.commandListId }, select: { id: true } }))) return NextResponse.json({ error: "unknown_command_list" }, { status: 400 });
  const p = await db.policyProfile.create({ data: v.value, select: { id: true } });
  await recordAdminAction({
    actor: { id: admin.id, email: admin.email }, action: "policy_profile.create", targetType: "policy_profile", targetId: p.id,
    summary: `Created policy profile "${v.value.name}"`, clientIp: clientIp(req.headers) ?? null,
  });
  return NextResponse.json({ id: p.id }, { status: 201 });
});
