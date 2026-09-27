import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/current-user";
import { recordAdminAction } from "@/lib/audit/admin";
import { clientIp } from "@/lib/request-ip";
import { can } from "@/lib/auth/roles";
import { db } from "@/lib/db";
import { createPairing } from "@/lib/connector/enrollment";
import { generateToken, hashToken } from "@/lib/auth/tokens";
import { kickConnector } from "@/lib/connector/dataplane";
import { canRepairConnector, buildReconfigureCommand } from "@/lib/connector/repair";
import { managerBaseUrl, connectorTunnelUrl, isLocalManagerUrl } from "@/lib/url";
import { withTenantRoute } from "@/lib/tenant/request";
import { SLOW_SCOPE_BUDGET_MS } from "@/lib/tenant/scope";

export const POST = withTenantRoute(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const admin = await getCurrentUser();
  if (!admin) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!can(admin.role, "configure")) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { id } = await ctx.params;

  const connector = await db.connector.findUnique({ where: { id }, select: { id: true, name: true, status: true } });
  if (!connector) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (!canRepairConnector(connector.status)) return NextResponse.json({ error: "not_repairable" }, { status: 409 });

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const invalidateNow = body.invalidateNow === true;

  // Bind a fresh pairing to THIS connector; redeeming it rotates the token in
  // place (preserving the connector id + its sites).
  const { code } = await createPairing(connector.name, { connectorId: id });

  if (invalidateNow) {
    // Kill the current (possibly compromised) token immediately: rotate the
    // hash to a throwaway whose plaintext is discarded, so nothing validates
    // until the new code is redeemed. Then drop the live session.
    const throwaway = await hashToken(generateToken());
    await db.connector.update({ where: { id }, data: { tokenHash: throwaway, status: "PENDING" } });
    await kickConnector(id);
  }

  const managerUrl = managerBaseUrl(req);
  const reconfigureCommand = buildReconfigureCommand(code, managerUrl, connectorTunnelUrl());
  const managerUrlIsLocal = isLocalManagerUrl(managerUrl);

  await recordAdminAction({
    actor: { id: admin.id, email: admin.email },
    action: "connector.repair",
    targetType: "connector", targetId: id,
    summary: `Repaired connector ${id}`,
    clientIp: clientIp(req.headers) ?? null,
  });
  return NextResponse.json({ code, reconfigureCommand, managerUrlIsLocal });
}, { budgetMs: SLOW_SCOPE_BUDGET_MS });
