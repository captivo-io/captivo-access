import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/current-user";
import { recordAdminAction } from "@/lib/audit/admin";
import { clientIp } from "@/lib/request-ip";
import { can } from "@/lib/auth/roles";
import { db } from "@/lib/db";
import { pushConnectorPolicy } from "@/lib/connector/policy";
import { parseTargets } from "@/lib/connector/egress-targets";
import { withTenantRoute } from "@/lib/tenant/request";
import { SLOW_SCOPE_BUDGET_MS } from "@/lib/tenant/scope";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LEVELS = ["debug", "info", "warn", "error"];

// The connector page's Settings tab: egress narrowing and log level saved
// together and pushed to the connector once. A field left out stays as it is.
export const POST = withTenantRoute(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const admin = await getCurrentUser();
  if (!admin) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!can(admin.role, "configure")) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  const data: { egressPolicy?: string | null; logLevel?: string | null } = {};
  if (typeof body.egressAllowedTargets === "string") {
    const p = parseTargets(body.egressAllowedTargets);
    if (p.invalid.length) return NextResponse.json({ error: "invalid_targets", invalid: p.invalid }, { status: 400 });
    data.egressPolicy = p.normalized || null;
  }
  if ("logLevel" in body) {
    // "" / null = follow the fleet default on the Policy page.
    const raw = typeof body.logLevel === "string" ? body.logLevel : "";
    if (raw && !LEVELS.includes(raw)) return NextResponse.json({ error: "invalid_log_level" }, { status: 400 });
    data.logLevel = raw || null;
  }
  if (Object.keys(data).length === 0) return NextResponse.json({ error: "nothing_to_update" }, { status: 400 });

  const updated = await db.connector.updateMany({ where: { id }, data });
  if (updated.count === 0) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const push = await pushConnectorPolicy(id);
  const actor = { id: admin.id, email: admin.email };
  const ip = clientIp(req.headers) ?? null;
  if ("egressPolicy" in data) {
    await recordAdminAction({ actor, action: "connector.egress_update", targetType: "connector", targetId: id, summary: `Updated egress policy for connector ${id}`, clientIp: ip });
  }
  if ("logLevel" in data) {
    await recordAdminAction({ actor, action: "connector.log_level", targetType: "connector", targetId: id, summary: `Set log level for connector ${id}`, clientIp: ip });
  }
  return NextResponse.json({ ok: true, live: push.ok, egressPolicy: data.egressPolicy, logLevel: data.logLevel });
}, { budgetMs: SLOW_SCOPE_BUDGET_MS });
