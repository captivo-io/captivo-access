import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/current-user";
import { can } from "@/lib/auth/roles";
import { db } from "@/lib/db";
import { recordAdminAction } from "@/lib/audit/admin";
import { clientIp } from "@/lib/request-ip";
import { withTenantRoute } from "@/lib/tenant/request";
import { MAX_COMMAND_LISTS, validateCommandList } from "@/lib/policy/command-lists";

export const dynamic = "force-dynamic";

export const GET = withTenantRoute(async () => {
  const admin = await getCurrentUser();
  if (!admin) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!can(admin.role, "read_console")) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const lists = await db.commandList.findMany({ orderBy: { name: "asc" }, include: { _count: { select: { sites: true, profiles: true } } } });
  return NextResponse.json({ lists: lists.map((l) => ({ id: l.id, name: l.name, description: l.description, mode: l.mode, entries: l.entries, resources: l._count.sites, profiles: l._count.profiles })) });
});

export const POST = withTenantRoute(async (req: NextRequest) => {
  const admin = await getCurrentUser();
  if (!admin) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!can(admin.role, "configure")) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const v = validateCommandList((await req.json().catch(() => ({}))) as Record<string, unknown>);
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 });
  if ((await db.commandList.count()) >= MAX_COMMAND_LISTS) return NextResponse.json({ error: "too_many_lists" }, { status: 409 });
  if (await db.commandList.findFirst({ where: { name: { equals: v.value.name, mode: "insensitive" } }, select: { id: true } })) return NextResponse.json({ error: "name_taken" }, { status: 409 });
  const l = await db.commandList.create({ data: v.value, select: { id: true } });
  await recordAdminAction({
    actor: { id: admin.id, email: admin.email }, action: "command_list.create", targetType: "command_list", targetId: l.id,
    summary: `Created ${v.value.mode} command list "${v.value.name}" with ${v.value.entries.length} ${v.value.entries.length === 1 ? "entry" : "entries"}`,
    clientIp: clientIp(req.headers) ?? null,
  });
  return NextResponse.json({ id: l.id }, { status: 201 });
});
