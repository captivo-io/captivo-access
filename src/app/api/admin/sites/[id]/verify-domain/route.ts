import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/current-user";
import { can } from "@/lib/auth/roles";
import { db } from "@/lib/db";
import { resolve4, expectedServerIp, verifyDecision } from "@/lib/site/verify-domain";
import { withTenantRoute } from "@/lib/tenant/request";
import { SLOW_SCOPE_BUDGET_MS } from "@/lib/tenant/scope";

export const dynamic = "force-dynamic";

export const POST = withTenantRoute(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!can(user.role, "configure")) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { id } = await ctx.params;

  const site = await db.site.findUnique({
    where: { id },
    select: { hostname: true, customDomain: true, accessMode: true },
  });
  if (!site || site.accessMode !== "TRANSPARENT" || !site.customDomain || !site.hostname) {
    return NextResponse.json({ error: "not_custom_domain" }, { status: 400 });
  }

  const expected = await expectedServerIp();
  if (!expected) return NextResponse.json({ status: "undetermined", reason: "server_ip_unresolved" });

  const resolved = await resolve4(site.hostname);
  const status = verifyDecision(expected, resolved);
  if (status === "ok") await db.site.update({ where: { id }, data: { domainVerifiedAt: new Date() } });

  return NextResponse.json({ status, expectedIp: expected, resolvedIp: resolved[0] ?? null });
}, { budgetMs: SLOW_SCOPE_BUDGET_MS });
