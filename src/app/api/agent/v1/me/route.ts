import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { withTenantRoute } from "@/lib/tenant/request";
import { withAgent } from "@/lib/agent/route";
import { listUserGrants } from "@/lib/access/grants";
import { classifyGrant } from "@/lib/access/classify";
import { agentKind } from "@/lib/agent/sites";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STATE: Record<string, string> = { allow: "active", pending_approval: "pending", not_yet: "scheduled", off_schedule: "off_hours" };

// Who this token is, and the resources it may ask for with where each stands.
export const GET = withTenantRoute(withAgent(async (_req, agent) => {
  const now = new Date();
  const [sites, grants] = await Promise.all([
    db.site.findMany({ where: { id: { in: agent.token.siteIds } }, select: { id: true, name: true, accessMode: true, vaultCredential: { select: { protocol: true } } }, orderBy: { name: "asc" } }),
    listUserGrants(agent.user.id),
  ]);
  const resources = sites.map((s) => {
    const live = grants
      .filter((g) => g.site.id === s.id)
      .map((g) => ({ g, state: STATE[classifyGrant(g, now)] }))
      .find((x) => x.state);
    return { id: s.id, name: s.name, kind: agentKind(s), access: live ? { id: live.g.id, state: live.state, startsAt: live.g.startsAt?.toISOString() ?? null, endsAt: live.g.endsAt?.toISOString() ?? null } : null };
  });
  return NextResponse.json({
    agent: { name: agent.token.name, expiresAt: agent.token.expiresAt.toISOString(), maxMinutes: agent.token.maxMinutes, autoApprove: agent.token.autoApprove, ratePerMinute: agent.token.ratePerMinute },
    resources,
  });
}));
