import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/current-user";
import { can } from "@/lib/auth/roles";
import { db } from "@/lib/db";
import { probeConnector } from "@/lib/connector/dataplane";
import { gatewayProbeUrl } from "@/lib/connector/health";
import { withTenantRoute } from "@/lib/tenant/request";
import { SLOW_SCOPE_BUDGET_MS } from "@/lib/tenant/scope";

// "Test connection" in the resource dialog, before the resource exists: can this
// connector reach this target from inside the customer's network? A TCP connect
// through the tunnel, nothing stored. The connector's own ALLOWED_TARGETS still
// applies, as for every connection it makes.
export const POST = withTenantRoute(async (req: NextRequest) => {
  const admin = await getCurrentUser();
  if (!admin) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!can(admin.role, "configure")) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const body = (await req.json().catch(() => ({}))) as { connectorId?: unknown; target?: unknown; port?: unknown };
  const connectorId = typeof body.connectorId === "string" ? body.connectorId : "";
  const target = typeof body.target === "string" ? body.target.trim() : "";
  if (!connectorId || !target) return NextResponse.json({ error: "target_required" }, { status: 400 });

  const connector = await db.connector.findUnique({ where: { id: connectorId }, select: { status: true } });
  if (!connector || connector.status === "REVOKED") return NextResponse.json({ error: "connector_not_found" }, { status: 400 });

  // An http(s) URL for web apps; host:port (or a bare host plus port) for remote desktops.
  let upstreamUrl: string;
  if (/^https?:\/\//i.test(target)) {
    try {
      upstreamUrl = new URL(target).toString();
    } catch {
      return NextResponse.json({ error: "invalid_target" }, { status: 400 });
    }
  } else {
    const m = /^\[?([^\]\s]+?)\]?(?::(\d{1,5}))?$/.exec(target);
    const port = m?.[2] ? Number(m[2]) : typeof body.port === "number" ? body.port : NaN;
    if (!m || !Number.isInteger(port) || port < 1 || port > 65535) return NextResponse.json({ error: "invalid_target" }, { status: 400 });
    upstreamUrl = gatewayProbeUrl(m[1], port);
  }
  const res = await probeConnector({ connectorId, upstreamUrl });
  return NextResponse.json("error" in res ? { ok: false, error: res.error } : { ok: true, ms: res.latencyMs });
}, { budgetMs: SLOW_SCOPE_BUDGET_MS });
