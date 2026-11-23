import { NextRequest, NextResponse } from "next/server";
import { releaseConnectorFromGroups } from "@/lib/connector/groups";
import type { Prisma } from "@/generated/prisma/client";
import { getCurrentUser } from "@/lib/current-user";
import { recordAdminAction } from "@/lib/audit/admin";
import { clientIp } from "@/lib/request-ip";
import { can } from "@/lib/auth/roles";
import { db } from "@/lib/db";
import { managerVersion } from "@/lib/version";
import { getConnectorTelemetry } from "@/lib/connector/telemetry";
import { kickConnector } from "@/lib/connector/dataplane";
import { recordConnectorEvent } from "@/lib/connector/history";
import {
  hostActionBusy, newHostActionId, remoteControl, storedHostAction, updateTarget,
  type StoredHostAction,
} from "@/lib/connector/host-action";
import { sendHostAction } from "@/lib/connector/host-action-send";
import { withTenantRoute } from "@/lib/tenant/request";
import { SLOW_SCOPE_BUDGET_MS } from "@/lib/tenant/scope";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Update or remove a connector from the console (its updater does the work on
 * the host), or cancel an update still waiting for the connector to be idle.
 *
 *   { action: "update", waitIdle?: boolean }   to the manager's own version
 *   { action: "uninstall", keepData?: boolean, confirmName }   also revokes it
 *   { action: "cancel" }
 */
export const POST = withTenantRoute(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const admin = await getCurrentUser();
  if (!admin) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!can(admin.role, "configure")) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const action = body.action;
  if (action !== "update" && action !== "uninstall" && action !== "cancel") return NextResponse.json({ error: "invalid_action" }, { status: 400 });

  const c = await db.connector.findUnique({ where: { id }, select: { id: true, name: true, status: true, version: true, hostAction: true, createdAt: true } });
  if (!c) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (c.status === "REVOKED") return NextResponse.json({ error: "revoked" }, { status: 409 });

  const tele = await getConnectorTelemetry(id).catch(() => ({ online: false as const, telemetry: null }));
  const t = tele.online ? tele.telemetry ?? null : null;
  const rc = remoteControl(tele.online && c.status === "ONLINE", t, c.createdAt);
  const actor = { id: admin.id, email: admin.email };
  const ip = clientIp(req.headers) ?? null;
  const save = (v: StoredHostAction) => db.connector.update({ where: { id }, data: { hostAction: v as unknown as Prisma.InputJsonValue } });

  if (action === "cancel") {
    const stored = storedHostAction(c.hostAction);
    if (!stored || stored.action !== "update" || t?.hostAction?.id !== stored.id || t.hostAction.state !== "waiting_idle") {
      return NextResponse.json({ ok: false, error: "not_pending" }, { status: 409 });
    }
    const r = await sendHostAction(id, { id: stored.id, action: "cancel" });
    if (!r.ok) return NextResponse.json({ ok: false, error: r.reason ?? "no_answer" }, { status: 409 });
    await save({ ...stored, state: "cancelled" });
    await recordConnectorEvent(id, "info", `Waiting update to ${stored.version} cancelled by ${admin.email}`);
    return NextResponse.json({ ok: true });
  }

  if (!rc.ok) return NextResponse.json({ ok: false, error: rc.reason }, { status: 409 });
  // An update held for idle may give way to a removal; anything else under way may not.
  if (hostActionBusy(t?.hostAction) && !(action === "uninstall" && t?.hostAction?.state === "waiting_idle")) {
    return NextResponse.json({ ok: false, error: "busy" }, { status: 409 });
  }

  const actionId = newHostActionId();
  const at = new Date().toISOString();

  if (action === "update") {
    const version = updateTarget(t?.version ?? c.version, managerVersion());
    if (!version) return NextResponse.json({ ok: false, error: "up_to_date" }, { status: 409 });
    const waitIdle = body.waitIdle === true;
    const r = await sendHostAction(id, { id: actionId, action: "update", version, waitIdle });
    if (!r.ok) return NextResponse.json({ ok: false, error: r.reason ?? "no_answer" }, { status: 409 });
    const stored: StoredHostAction = { id: actionId, action: "update", version, waitIdle, by: admin.email, at, state: "sent", from: t?.version ?? c.version ?? undefined };
    await save(stored);
    await recordConnectorEvent(id, "info", `Update to ${version} ${waitIdle ? "queued until idle" : "started"} by ${admin.email}`);
    await recordAdminAction({ actor, action: "connector.update_remote", targetType: "connector", targetId: id, summary: `Updated connector ${c.name} to ${version} from the console${waitIdle ? " (when idle)" : ""}`, clientIp: ip });
    return NextResponse.json({ ok: true, hostAction: stored });
  }

  // uninstall: typed name, then the request, then the revoke. Revoking first
  // would close the tunnel the request travels on.
  if (typeof body.confirmName !== "string" || body.confirmName.trim() !== c.name.trim()) {
    return NextResponse.json({ ok: false, error: "confirm_mismatch" }, { status: 400 });
  }
  const keepData = body.keepData !== false;
  const r = await sendHostAction(id, { id: actionId, action: "uninstall", keepData });
  if (!r.ok) return NextResponse.json({ ok: false, error: r.reason ?? "no_answer" }, { status: 409 });
  const stored: StoredHostAction = { id: actionId, action: "uninstall", keepData, by: admin.email, at, state: "removing" };
  await releaseConnectorFromGroups(db, id); // its connector-group resources move to another member
  await db.connector.update({ where: { id }, data: { status: "REVOKED", hostAction: stored as unknown as Prisma.InputJsonValue } });
  await kickConnector(id);
  await recordConnectorEvent(id, "warn", `Removed from its host by ${admin.email}${keepData ? " (recordings and keys kept on the host)" : ""}`);
  await recordAdminAction({
    actor, action: "connector.uninstall_remote", targetType: "connector", targetId: id,
    summary: `Removed connector ${c.name} from its host and revoked it${keepData ? "; recordings and keys left on the host" : "; recordings and keys deleted"}`,
    clientIp: ip,
  });
  return NextResponse.json({ ok: true, hostAction: stored });
}, { budgetMs: SLOW_SCOPE_BUDGET_MS });
