import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/current-user";
import { can } from "@/lib/auth/roles";
import { db } from "@/lib/db";
import { encrypt } from "@/lib/crypto";
import { recordAdminAction } from "@/lib/audit/admin";
import { clientIp } from "@/lib/request-ip";
import { multiTenantEnabled } from "@/lib/tenant/enabled";
import { currentTenantId } from "@/lib/tenant/context";
import { withTenantRoute } from "@/lib/tenant/request";
import { CONFIG_ERROR, parseSystem, secretRequired } from "@/lib/ticketing/config";
import { KIND_LABEL, MODE_LABEL } from "@/lib/ticketing/rules";

export const runtime = "nodejs";

/**
 * Saves the ticket system. The stored password or token is kept when the
 * field is left blank and neither the kind nor the address changed, so it
 * can't follow a new address it was never meant for.
 */
export const PUT = withTenantRoute(async (req: NextRequest) => {
  const admin = await getCurrentUser();
  if (!admin) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!can(admin.role, "configure")) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const p = parseSystem(body, { cloud: multiTenantEnabled() });
  if (!p.ok) return NextResponse.json({ error: p.error, message: CONFIG_ERROR[p.error] }, { status: 400 });
  const existing = await db.ticketSystem.findUnique({ where: { tenantId: currentTenantId() }, select: { kind: true, baseUrl: true, secret: true } });
  const kept = existing && existing.kind === p.data.kind && existing.baseUrl === p.data.baseUrl ? existing.secret : null;
  const secret = p.data.kind === "none" ? null : p.secret ? encrypt(p.secret) : kept;
  if (!secret && secretRequired(p.data.kind)) return NextResponse.json({ error: "secret_required", message: CONFIG_ERROR.secret_required }, { status: 400 });
  const data = { ...p.data, secret, ...(existing?.kind !== p.data.kind || existing?.baseUrl !== p.data.baseUrl ? { lastOkAt: null, lastError: null, lastErrorAt: null } : {}) };
  await db.ticketSystem.upsert({ where: { tenantId: currentTenantId() }, create: data, update: data });
  await recordAdminAction({
    actor: { id: admin.id, email: admin.email },
    action: "config.ticketing",
    summary: `Set the ticket system to ${KIND_LABEL[p.data.kind]}${p.data.baseUrl ? ` (${new URL(p.data.baseUrl).host})` : ""}; resources by default: ${MODE_LABEL[p.data.defaultMode]}`,
    metadata: { kind: p.data.kind, defaultMode: p.data.defaultMode, matchAssignee: p.data.matchAssignee, writeNotes: p.data.writeNotes, secretChanged: !!p.secret },
    clientIp: clientIp(req.headers) ?? null,
  });
  return NextResponse.json({ ok: true, hasSecret: !!secret });
});
