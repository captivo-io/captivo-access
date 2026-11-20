import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/current-user";
import { can } from "@/lib/auth/roles";
import { db } from "@/lib/db";
import { createPairing } from "@/lib/connector/enrollment";
import { kickConnector } from "@/lib/connector/dataplane";
import { managerBaseUrl, connectorTunnelUrl, isLocalManagerUrl } from "@/lib/url";
import { buildInstallCommand } from "@/lib/connector/repair";
import { recordAdminAction } from "@/lib/audit/admin";
import { clientIp } from "@/lib/request-ip";
import { withTenantRoute } from "@/lib/tenant/request";
import { assertWithinLimit, LimitError } from "@/lib/tenant/envelope";

export const POST = withTenantRoute(async (req: NextRequest) => {
  const admin = await getCurrentUser();
  if (!admin) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!can(admin.role, "configure")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) {
    return NextResponse.json({ error: "name_required" }, { status: 400 });
  }
  try {
    await assertWithinLimit("maxConnectors", await db.connector.count({ where: { status: { not: "REVOKED" } } }));
  } catch (e) {
    if (e instanceof LimitError) return NextResponse.json({ error: "limit_reached", limit: e.key, max: e.max }, { status: 409 });
    throw e;
  }
  const { code } = await createPairing(name);
  const managerUrl = managerBaseUrl(req);
  const installCommand = buildInstallCommand(code, managerUrl, connectorTunnelUrl());
  // The same without the updater, for an admin who turns updates from the console off.
  const installCommandManual = buildInstallCommand(code, managerUrl, connectorTunnelUrl(), false);
  // A connector runs on a different machine, so a localhost manager URL (seen
  // when the admin browses via an SSH tunnel) won't be reachable from it.
  const managerUrlIsLocal = isLocalManagerUrl(managerUrl);

  await recordAdminAction({
    actor: { id: admin.id, email: admin.email },
    action: "connector.create",
    targetType: "connector",
    summary: `Created connector "${name}"`,
    clientIp: clientIp(req.headers) ?? null,
  });
  return NextResponse.json({ code, installCommand, installCommandManual, managerUrlIsLocal });
});

export const GET = withTenantRoute(async () => {
  const admin = await getCurrentUser();
  if (!admin) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!can(admin.role, "read_console")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const connectors = await db.connector.findMany({
    select: { id: true, name: true, status: true, lastSeenAt: true, version: true },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json({ connectors });
});

export const DELETE = withTenantRoute(async (req: NextRequest) => {
  const admin = await getCurrentUser();
  if (!admin) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!can(admin.role, "configure")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const id = req.nextUrl.searchParams.get("id");
  if (!id) {
    return NextResponse.json({ error: "id_required" }, { status: 400 });
  }

  const target = await db.connector.findUnique({ where: { id }, select: { id: true } });
  if (!target) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  await db.connector.update({ where: { id }, data: { status: "REVOKED" } });
  await kickConnector(id);
  await recordAdminAction({
    actor: { id: admin.id, email: admin.email },
    action: "connector.revoke",
    targetType: "connector", targetId: id,
    summary: `Revoked connector ${id}`,
    clientIp: clientIp(req.headers) ?? null,
  });
  return NextResponse.json({ ok: true });
});
