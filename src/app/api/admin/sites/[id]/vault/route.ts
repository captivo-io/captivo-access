import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/current-user";
import { can } from "@/lib/auth/roles";
import { vaultEnabled } from "@/lib/vault/enabled";
import { setVaultCredential, clearVaultCredential, secretInputFrom, VaultInputError } from "@/lib/vault/store";
import { db } from "@/lib/db";
import { parseGuacParams } from "@/lib/gateway/guac-params";
import { recordAdminAction } from "@/lib/audit/admin";
import { clientIp } from "@/lib/request-ip";
import { withTenantRoute } from "@/lib/tenant/request";
import { capabilityAllowed } from "@/lib/tenant/envelope";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PROTOCOLS = ["RDP", "SSH", "VNC"] as const;
const KINDS = ["PASSWORD", "KEY"] as const;

export const PUT = withTenantRoute(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const admin = await getCurrentUser();
  if (!admin) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!can(admin.role, "configure")) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  if (!vaultEnabled() || !(await capabilityAllowed("vault"))) return NextResponse.json({ error: "vault_disabled" }, { status: 403 });

  const { id } = await params;
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const protocol = String(b.protocol) as (typeof PROTOCOLS)[number];
  const secretKind = String(b.secretKind ?? "PASSWORD") as (typeof KINDS)[number];
  const port = Number(b.targetPort);
  const targetHost = typeof b.targetHost === "string" ? b.targetHost.trim() : "";
  const username = typeof b.username === "string" ? b.username.trim() : "";
  const secret = secretInputFrom(b);
  if (!PROTOCOLS.includes(protocol) || !KINDS.includes(secretKind)) {
    return NextResponse.json({ error: "invalid_protocol" }, { status: 400 });
  }
  if (!targetHost || !Number.isInteger(port) || port < 1 || port > 65535 || !username || !secret) {
    return NextResponse.json({ error: "invalid_fields" }, { status: 400 });
  }
  // The resource must be this tenant's (RLS hides others'): without this check an
  // upsert for another tenant's resource id created a stray row under ours that
  // then blocked that resource's own credential.
  const site = await db.site.findUnique({ where: { id }, select: { connectorId: true, connectorGroupId: true, accessMode: true } });
  if (!site) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (site.accessMode !== "GATEWAY") return NextResponse.json({ error: "not_remote_desktop" }, { status: 400 });
  try {
    await setVaultCredential({ siteId: id, connectorId: site.connectorId, connectorGroupId: site.connectorGroupId, protocol, targetHost, targetPort: port, username, secret, secretKind, guacParams: parseGuacParams(b.guacParams) });
  } catch (e) {
    if (e instanceof VaultInputError) return NextResponse.json({ error: e.message }, { status: 409 });
    throw e;
  }
  await recordAdminAction({
    actor: { id: admin.id, email: admin.email },
    action: "resource.vault_update", targetType: "resource", targetId: id,
    summary: `Updated vault credential for resource ${id}`,
    clientIp: clientIp(req.headers) ?? null,
  });
  return NextResponse.json({ ok: true });
});

export const DELETE = withTenantRoute(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const admin = await getCurrentUser();
  if (!admin) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!can(admin.role, "configure")) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { id } = await params;
  await clearVaultCredential(id);
  await recordAdminAction({
    actor: { id: admin.id, email: admin.email },
    action: "resource.vault_update", targetType: "resource", targetId: id,
    summary: `Cleared vault credential for resource ${id}`,
    clientIp: clientIp(req.headers) ?? null,
  });
  return NextResponse.json({ ok: true });
});
