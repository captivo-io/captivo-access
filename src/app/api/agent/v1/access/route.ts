import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { withTenantRoute } from "@/lib/tenant/request";
import { SLOW_SCOPE_BUDGET_MS } from "@/lib/tenant/scope";
import { withAgent } from "@/lib/agent/route";
import { AGENT_MIN_REASON, agentMinutes } from "@/lib/agent/tokens";
import { createAccessRequest, listUserGrants } from "@/lib/access/grants";
import { classifyGrant } from "@/lib/access/classify";
import { grantCapError } from "@/lib/access/grant-edit";
import { resolvedMaxGrantDays } from "@/lib/settings/platform";
import { gateTicket } from "@/lib/ticketing/system";
import { ticketApprovalAudit } from "@/lib/ticketing/audit";
import { workspaceView } from "@/lib/mobile/views";
import { recordAdminAction } from "@/lib/audit/admin";
import { clientIp } from "@/lib/request-ip";
import { notifyApprovers } from "@/lib/agent/notify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// An agent asks for access to one resource for a number of minutes, with a
// reason. It goes the way a person's request goes: a person approves it (or a
// ticket in the workspace's ticket system does), unless the token was made to
// approve its own requests, within its limits. Nothing outlives the window.
export const POST = withTenantRoute(withAgent(async (req, agent) => {
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const siteId = typeof b.siteId === "string" ? b.siteId.trim() : "";
  if (!siteId) return NextResponse.json({ error: "site_required" }, { status: 400 });
  if (!agent.token.siteIds.includes(siteId)) return NextResponse.json({ error: "site_not_allowed" }, { status: 403 });
  const reason = typeof b.reason === "string" ? b.reason.trim() : "";
  if (reason.length < AGENT_MIN_REASON) return NextResponse.json({ error: "reason_required", message: `Say why, in at least ${AGENT_MIN_REASON} characters.` }, { status: 400 });
  const minutes = agentMinutes(b.minutes, agent.token.maxMinutes);
  if (minutes === null) return NextResponse.json({ error: "invalid_minutes" }, { status: 400 });

  const now = new Date();
  const startsAt = now;
  const endsAt = new Date(now.getTime() + minutes * 60_000);
  const capErr = grantCapError(startsAt, endsAt, now, await resolvedMaxGrantDays());
  if (capErr) return NextResponse.json({ error: capErr }, { status: 400 });
  const site = await db.site.findUnique({ where: { id: siteId }, select: { id: true, name: true, ticketMode: true } });
  if (!site) return NextResponse.json({ error: "site_not_found" }, { status: 404 });

  // One at a time: a request already waiting, or access already running, is answered, not duplicated.
  const held = (await listUserGrants(agent.user.id)).find((g) => g.site.id === siteId && ["allow", "pending_approval", "not_yet", "off_schedule"].includes(classifyGrant(g, now)));
  if (held) return NextResponse.json({ error: "already_requested", id: held.id, status: held.approvedAt || !held.requiresApproval ? "approved" : "pending", endsAt: held.endsAt?.toISOString() ?? null }, { status: 409 });

  const ws = await workspaceView().catch(() => ({ slug: null as string | null }));
  const gate = await gateTicket({ ref: b.ticket, sites: [site], who: { email: agent.user.email, name: agent.user.name }, startsAt, endsAt, workspace: ws.slug ?? "default" });
  if (!gate.ok) return NextResponse.json({ error: gate.error, message: gate.message }, { status: gate.status });
  if (gate.startsAt && gate.endsAt && gate.startsAt >= gate.endsAt) return NextResponse.json({ error: "ticket_window_over" }, { status: 400 });

  const result = await createAccessRequest({
    userId: agent.user.id, siteId, startsAt: gate.startsAt, endsAt: gate.endsAt,
    note: `Agent "${agent.token.name}": ${reason}`.slice(0, 500), schedule: null, ticket: gate.ticket, approvedByTicket: gate.approvedByTicket,
  });
  if (!result.ok) return NextResponse.json({ error: result.reason }, { status: 409 });
  const ip = clientIp(req.headers) ?? null;
  const window = { startsAt: gate.startsAt?.toISOString() ?? null, endsAt: gate.endsAt?.toISOString() ?? null };

  if (gate.approvedByTicket && gate.ticket) {
    await ticketApprovalAudit(result.id, gate.ticket.ticketRef, gate.system, `${agent.user.name} → ${site.name}`);
    return NextResponse.json({ id: result.id, status: "approved", via: "ticket", ...window }, { status: 201 });
  }
  if (agent.token.autoApprove) {
    // Approved by the token's own terms: only this resource, only up to its limit. Recorded as such.
    await db.accessGrant.update({ where: { id: result.id }, data: { approvedAt: new Date() } });
    await recordAdminAction({
      actor: { id: agent.user.id, email: agent.user.email }, action: "grant.auto_approved", targetType: "grant", targetId: result.id,
      summary: `Agent "${agent.token.name}" was given ${site.name} for ${minutes} minutes without a person's approval (its token allows that): ${reason}`,
      metadata: { siteId, minutes, tokenId: agent.token.id }, clientIp: ip,
    });
    return NextResponse.json({ id: result.id, status: "approved", via: "token", ...window }, { status: 201 });
  }
  await notifyApprovers({ who: `Agent "${agent.token.name}"`, email: agent.user.email, siteName: site.name, grantId: result.id, reason, ticketRef: gate.ticket?.ticketRef });
  return NextResponse.json({ id: result.id, status: "pending", ...window }, { status: 201 });
}), { budgetMs: SLOW_SCOPE_BUDGET_MS });
