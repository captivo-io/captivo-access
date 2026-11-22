import { db } from "@/lib/db";
import { inTenant } from "@/lib/cron/for-each-tenant";
import { revokeGrant } from "@/lib/access/grants";
import { lookupTicket, describeSystemError, TicketSystemError } from "./providers";
import { checksTickets, grantTicketData, loadTicketSystem, noteHealth, systemLabel, systemSecret, systemSpec } from "./system";
import { effectiveMode, readSnapshot, refusalText, snapshot, verdict, type TicketFacts, type TicketKind } from "./rules";
import { TICKET_ACTOR, ticketApprovalAudit, ticketRevokeAudit } from "./audit";
import { recordAdminAction } from "@/lib/audit/admin";

// Every few minutes, the tickets behind live grants are asked again. A ticket
// that was closed, cancelled, moved out of an allowed state, reassigned (when
// that is checked) or whose window ended ends its grants, and the live-session
// recheck cuts their sessions within a minute. A window that moved earlier
// moves the grant's end with it. A request waiting on a resource that takes an
// approved ticket as approval opens as soon as the ticket is approved.
//
// A ticket system that doesn't answer ends nothing: an outage of someone
// else's service must not lock every vendor out. It is shown on the page.

/** Tickets asked per tenant per pass; the least recently checked go first. */
const MAX_TICKETS = 100;

export type TicketPassResult = { checked: number; ended: number; approved: number; shortened: number; failed: number; approvedMail: { to: string; site: string }[] };

export async function runTicketPass(tenantId: string | null, now = new Date()): Promise<TicketPassResult> {
  const out: TicketPassResult = { checked: 0, ended: 0, approved: 0, shortened: 0, failed: 0, approvedMail: [] };
  const read = await inTenant(tenantId, async () => {
    const sys = await loadTicketSystem();
    if (!checksTickets(sys)) return null;
    const grants = await db.accessGrant.findMany({
      where: { status: "ACTIVE", ticketRef: { not: null }, directoryManaged: false, OR: [{ endsAt: null }, { endsAt: { gt: now } }] },
      orderBy: { ticketCheckedAt: { sort: "asc", nulls: "first" } },
      select: {
        id: true, ticketRef: true, ticket: true, requiresApproval: true, approvedAt: true, endsAt: true,
        user: { select: { email: true, name: true } }, site: { select: { id: true, name: true, ticketMode: true } },
      },
      take: MAX_TICKETS * 5,
    });
    return { sys, grants };
  });
  if (!read || read.grants.length === 0) return out;
  const { sys, grants } = read;
  const kind = sys.kind as TicketKind;
  const secret = systemSecret(sys);
  if (secret === undefined) return out;

  // One lookup per ticket, outside the tenant scope (it waits on their system).
  const refs = [...new Set(grants.map((g) => g.ticketRef!))].slice(0, MAX_TICKETS);
  const facts = new Map<string, TicketFacts | null>();
  let lastError: string | null = null;
  for (const ref of refs) {
    const g = grants.find((x) => x.ticketRef === ref)!;
    try {
      facts.set(ref, await lookupTicket(systemSpec(sys), secret, ref, { user: { email: g.user.email, name: g.user.name }, resource: { id: g.site.id, name: g.site.name }, workspace: "" }));
      out.checked++;
    } catch (e) {
      out.failed++;
      lastError = describeSystemError(e);
      // A refused login or a wrong address fails every ticket alike: stop asking.
      if (e instanceof TicketSystemError && (e.reason === "auth" || e.reason === "private_address" || e.reason === "not_configured")) break;
    }
  }

  const label = systemLabel(sys);
  await inTenant(tenantId, async () => {
    await noteHealth(out.checked === 0 && lastError ? lastError : null);
    for (const g of grants) {
      const ref = g.ticketRef!;
      if (!facts.has(ref)) continue;
      const f = facts.get(ref) ?? null;
      const what = `${g.user.name ?? g.user.email}'s access to ${g.site.name}`;
      const v = verdict(f, { kind, allowedStates: sys.allowedStates, matchAssignee: sys.matchAssignee }, { email: g.user.email }, now);
      const pending = g.requiresApproval && !g.approvedAt;
      if (!v.ok) {
        const why = refusalText(v.why, v.detail, label);
        if (pending) {
          const res = await db.accessGrant.updateMany({ where: { id: g.id, status: "ACTIVE", approvedAt: null }, data: { status: "DENIED", approvedAt: now, denyReason: why.slice(0, 500), ...grantTicketData({ ticketRef: ref, ticket: snapshot(kind, f), ticketVerified: !!f, ticketCheckedAt: now }) } });
          if (res.count) await recordAdminAction({ actor: TICKET_ACTOR, action: "grant.deny", targetType: "grant", targetId: g.id, summary: `Denied access request ${g.id} (${what}): ${why} (ticket ${ref})`, metadata: { ticket: ref } });
        } else {
          await revokeGrant(g.id, { reason: `ticket:${v.why}` });
          await db.accessGrant.update({ where: { id: g.id }, data: grantTicketData({ ticketRef: ref, ticket: snapshot(kind, f), ticketVerified: !!f, ticketCheckedAt: now }) });
          await ticketRevokeAudit(g.id, ref, why, what);
        }
        await db.notification.create({ data: { type: "ticket_ended", siteName: g.site.name, detail: `${g.user.name ?? g.user.email}: ${ref}: ${why}` } }).catch(() => undefined);
        out.ended++;
        continue;
      }
      const data: Record<string, unknown> = grantTicketData({ ticketRef: ref, ticket: snapshot(kind, f), ticketVerified: true, ticketCheckedAt: now });
      if (f?.end && (!g.endsAt || f.end < g.endsAt)) {
        data.endsAt = f.end;
        out.shortened++;
        await recordAdminAction({ actor: TICKET_ACTOR, action: "grant.update", targetType: "grant", targetId: g.id, summary: `Moved the end of ${what} to ticket ${ref}'s window`, metadata: { ticket: ref, endsAt: f.end.toISOString() } });
      }
      if (pending && v.approved && effectiveMode(g.site.ticketMode, sys) === "itsm") {
        const res = await db.accessGrant.updateMany({ where: { id: g.id, status: "ACTIVE", approvedAt: null }, data: { approvedAt: now } });
        if (res.count) {
          out.approved++;
          await ticketApprovalAudit(g.id, ref, label, what);
          await db.notification.create({ data: { type: "ticket_approved", siteName: g.site.name, detail: `${g.user.name ?? g.user.email}: ${ref} was approved in ${label}` } }).catch(() => undefined);
          out.approvedMail.push({ to: g.user.email, site: g.site.name });
        }
      }
      // The snapshot is only rewritten when something in it changed.
      const before = readSnapshot(g.ticket);
      const after = snapshot(kind, f);
      if (data.endsAt || JSON.stringify(before) !== JSON.stringify(after) || !before) await db.accessGrant.update({ where: { id: g.id }, data });
      else await db.accessGrant.update({ where: { id: g.id }, data: { ticketCheckedAt: now, ticketVerified: true } });
    }
  });
  return out;
}
