import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/current-user";
import { can } from "@/lib/auth/roles";
import { applyGrantDecision } from "@/lib/access/decision";
import { clientIp } from "@/lib/request-ip";
import { withTenantRoute } from "@/lib/tenant/request";
import { SLOW_SCOPE_BUDGET_MS } from "@/lib/tenant/scope";

export const POST = withTenantRoute(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const admin = await getCurrentUser();
  if (!admin) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!can(admin.role, "approve_grants")) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const decision = body.decision;
  if (decision !== "approve" && decision !== "deny") {
    return NextResponse.json({ error: "invalid_decision" }, { status: 400 });
  }

  const outcome = await applyGrantDecision({
    actor: { id: admin.id, email: admin.email },
    grantId: id,
    decision,
    reason: body.reason,
    clientIp: clientIp(req.headers) ?? null,
  });
  if (outcome === "not_pending") return NextResponse.json({ error: "not_pending" }, { status: 409 });
  return NextResponse.json({ ok: true });
}, { budgetMs: SLOW_SCOPE_BUDGET_MS });
