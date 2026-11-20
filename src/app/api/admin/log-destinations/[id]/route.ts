import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/current-user";
import { recordAdminAction } from "@/lib/audit/admin";
import { clientIp } from "@/lib/request-ip";
import { can } from "@/lib/auth/roles";
import { db } from "@/lib/db";
import { withTenantRoute } from "@/lib/tenant/request";
import { destinationFromBody } from "@/lib/logforward/api";
import { pumpSoon } from "@/lib/logforward/pump";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Changes a destination. `{ enabled }` alone switches it on or off;
 * `{ action: "retry" }` tries again now instead of after the wait; any other
 * body is the whole form. The cursors are kept: a changed destination carries
 * on from where the old one stopped.
 */
export const PATCH = withTenantRoute(async (req: NextRequest, { params }: Ctx) => {
  const admin = await getCurrentUser();
  if (!admin) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!can(admin.role, "configure")) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const existing = await db.logDestination.findUnique({ where: { id }, select: { id: true, name: true, kind: true, secret: true, enabled: true } });
  if (!existing) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const actor = { id: admin.id, email: admin.email };
  const ip = clientIp(req.headers) ?? null;

  if (body.action === "retry") {
    await db.logDestination.update({ where: { id }, data: { nextAttemptAt: null } });
    pumpSoon({ force: true });
    return NextResponse.json({ ok: true });
  }

  if (Object.keys(body).length === 1 && typeof body.enabled === "boolean") {
    await db.logDestination.update({ where: { id }, data: { enabled: body.enabled, ...(body.enabled ? { nextAttemptAt: null, failures: 0 } : {}) } });
    await recordAdminAction({
      actor, action: "config.log_destination_update", targetType: "log_destination", targetId: id, clientIp: ip,
      summary: `${body.enabled ? "Resumed" : "Paused"} log destination ${existing.name}`,
    });
    if (body.enabled) pumpSoon({ force: true });
    return NextResponse.json({ ok: true });
  }

  const r = await destinationFromBody(body, existing);
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
  await db.logDestination.update({ where: { id }, data: { ...r.data, nextAttemptAt: null, failures: 0, lastError: null } });
  await recordAdminAction({
    actor, action: "config.log_destination_update", targetType: "log_destination", targetId: id, clientIp: ip,
    summary: `Updated log destination ${r.data.name}`,
  });
  if (r.data.enabled) pumpSoon({ force: true });
  return NextResponse.json({ ok: true });
});

export const DELETE = withTenantRoute(async (req: NextRequest, { params }: Ctx) => {
  const admin = await getCurrentUser();
  if (!admin) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!can(admin.role, "configure")) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { id } = await params;
  const existing = await db.logDestination.findUnique({ where: { id }, select: { name: true } });
  if (!existing) return NextResponse.json({ error: "not_found" }, { status: 404 });
  await db.logDestination.delete({ where: { id } });
  await recordAdminAction({
    actor: { id: admin.id, email: admin.email }, action: "config.log_destination_delete", targetType: "log_destination", targetId: id,
    summary: `Removed log destination ${existing.name}`, clientIp: clientIp(req.headers) ?? null,
  });
  return NextResponse.json({ ok: true });
});
