import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/current-user";
import { can } from "@/lib/auth/roles";
import { db } from "@/lib/db";
import { getConnectorTelemetry } from "@/lib/connector/telemetry";
import { withTenantRoute } from "@/lib/tenant/request";
import { SLOW_SCOPE_BUDGET_MS } from "@/lib/tenant/scope";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The connector page polls this every 10 s for its live counters and log tails.
export const GET = withTenantRoute(async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const admin = await getCurrentUser();
  if (!admin) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!can(admin.role, "configure")) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { id } = await params;
  const c = await db.connector.findUnique({ where: { id }, select: { id: true, status: true, lastSeenAt: true } });
  if (!c) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const tele = c.status === "REVOKED" ? { online: false } : await getConnectorTelemetry(id).catch(() => ({ online: false }));
  return NextResponse.json({ ...tele, status: c.status, lastSeenAt: c.lastSeenAt?.toISOString() ?? null }, { headers: { "cache-control": "no-store" } });
}, { budgetMs: SLOW_SCOPE_BUDGET_MS });
