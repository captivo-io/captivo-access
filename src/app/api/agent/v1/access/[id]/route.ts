import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { withTenantRoute } from "@/lib/tenant/request";
import { withAgent } from "@/lib/agent/route";
import { classifyGrant } from "@/lib/access/classify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STATUS: Record<string, string> = { allow: "active", pending_approval: "pending", not_yet: "scheduled", off_schedule: "off_hours", denied: "denied", revoked: "revoked", expired: "expired" };

// Where one of this agent's requests stands. Only its own.
export const GET = withTenantRoute(withAgent(async (_req, agent, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const g = await db.accessGrant.findFirst({
    where: { id, userId: agent.user.id },
    select: { id: true, siteId: true, startsAt: true, endsAt: true, status: true, requiresApproval: true, approvedAt: true, schedule: true, denyReason: true, revokeReason: true },
  });
  if (!g) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({
    id: g.id, siteId: g.siteId, status: STATUS[classifyGrant(g, new Date())] ?? "unknown",
    startsAt: g.startsAt?.toISOString() ?? null, endsAt: g.endsAt?.toISOString() ?? null,
    ...(g.denyReason ? { reason: g.denyReason } : g.revokeReason ? { reason: g.revokeReason } : {}),
  });
}));
