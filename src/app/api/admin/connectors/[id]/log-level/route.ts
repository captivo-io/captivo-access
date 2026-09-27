import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/current-user";
import { recordAdminAction } from "@/lib/audit/admin";
import { clientIp } from "@/lib/request-ip";
import { can } from "@/lib/auth/roles";
import { db } from "@/lib/db";
import { pushConnectorPolicy } from "@/lib/connector/policy";
import { withTenantRoute } from "@/lib/tenant/request";
import { SLOW_SCOPE_BUDGET_MS } from "@/lib/tenant/scope";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LEVELS = ["debug", "info", "warn", "error"];

export const POST = withTenantRoute(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const admin = await getCurrentUser();
  if (!admin) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!can(admin.role, "configure")) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  // "" / "default" / "inherit" -> null = use the fleet default (Policy page).
  const raw = typeof body.logLevel === "string" ? body.logLevel : "";
  const level = LEVELS.includes(raw) ? raw : null;

  const updated = await db.connector.updateMany({ where: { id }, data: { logLevel: level } });
  if (updated.count === 0) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const push = await pushConnectorPolicy(id);
  await recordAdminAction({
    actor: { id: admin.id, email: admin.email },
    action: "connector.log_level",
    targetType: "connector", targetId: id,
    summary: `Set log level for connector ${id}`,
    clientIp: clientIp(req.headers) ?? null,
  });
  return NextResponse.json({ ok: true, live: push.ok });
}, { budgetMs: SLOW_SCOPE_BUDGET_MS });
