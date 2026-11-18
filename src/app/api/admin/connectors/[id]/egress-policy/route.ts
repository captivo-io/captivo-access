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

export const POST = withTenantRoute(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const admin = await getCurrentUser();
  if (!admin) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!can(admin.role, "configure")) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  // The connector splits on commas only and drops a whole update with a bad
  // entry (see parseTargets), so normalise and validate before saving.
  const parsed = parseTargets(typeof body.egressAllowedTargets === "string" ? body.egressAllowedTargets : "");
  if (parsed.invalid.length) return NextResponse.json({ error: "invalid_targets", invalid: parsed.invalid }, { status: 400 });
  const egress = parsed.normalized;

  const updated = await db.connector.updateMany({ where: { id }, data: { egressPolicy: egress || null } });
  if (updated.count === 0) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const push = await pushConnectorPolicy(id);
  await recordAdminAction({
    actor: { id: admin.id, email: admin.email },
    action: "connector.egress_update",
    targetType: "connector", targetId: id,
    summary: `Updated egress policy for connector ${id}`,
    clientIp: clientIp(req.headers) ?? null,
  });
  return NextResponse.json({ ok: true, live: push.ok });
}, { budgetMs: SLOW_SCOPE_BUDGET_MS });
