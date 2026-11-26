import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/current-user";
import { can } from "@/lib/auth/roles";
import { db } from "@/lib/db";
import { recordAdminAction } from "@/lib/audit/admin";
import { clientIp } from "@/lib/request-ip";
import { withTenantRoute } from "@/lib/tenant/request";
import { validateCommandList } from "@/lib/policy/command-lists";

export const dynamic = "force-dynamic";

export const PATCH = withTenantRoute(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const admin = await getCurrentUser();
  if (!admin) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!can(admin.role, "configure")) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { id } = await ctx.params;
  const cur = await db.commandList.findUnique({ where: { id } });
  if (!cur) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  // An edit may send only what changed.
  const v = validateCommandList({ name: cur.name, mode: cur.mode, entries: cur.entries, description: cur.description, ...body });
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 });
  if (await db.commandList.findFirst({ where: { id: { not: id }, name: { equals: v.value.name, mode: "insensitive" } }, select: { id: true } })) return NextResponse.json({ error: "name_taken" }, { status: 409 });
  await db.commandList.update({ where: { id }, data: v.value });
  await recordAdminAction({
    actor: { id: admin.id, email: admin.email }, action: "command_list.update", targetType: "command_list", targetId: id,
    summary: `Updated ${v.value.mode} command list "${v.value.name}" (${v.value.entries.length} ${v.value.entries.length === 1 ? "entry" : "entries"}); sessions opened from now on use it`,
    clientIp: clientIp(req.headers) ?? null,
  });
  return NextResponse.json({ ok: true });
});

export const DELETE = withTenantRoute(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const admin = await getCurrentUser();
  if (!admin) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!can(admin.role, "configure")) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { id } = await ctx.params;
  const cur = await db.commandList.findUnique({ where: { id }, include: { _count: { select: { sites: true, profiles: true } } } });
  if (!cur) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (cur._count.sites + cur._count.profiles > 0) {
    return NextResponse.json({ error: "in_use", resources: cur._count.sites, profiles: cur._count.profiles }, { status: 409 });
  }
  await db.commandList.delete({ where: { id } });
  await recordAdminAction({
    actor: { id: admin.id, email: admin.email }, action: "command_list.delete", targetType: "command_list", targetId: id,
    summary: `Deleted command list "${cur.name}"`, clientIp: clientIp(req.headers) ?? null,
  });
  return NextResponse.json({ ok: true });
});
