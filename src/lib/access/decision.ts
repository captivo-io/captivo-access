import { decideGrant } from "@/lib/access/grants";
import { normalizeDenyReason } from "@/lib/access/deny-reason";
import { db } from "@/lib/db";
import { sendMail } from "@/lib/email/mailer";
import { accessDecisionEmail } from "@/lib/email/templates";
import { notifyEmailEnabled } from "@/lib/notifications/gate";
import { recordAdminAction } from "@/lib/audit/admin";
import { consoleBaseUrl } from "@/lib/tenant/console-url";
import { checksTickets, grantTicketData, loadTicketSystem, lookup, systemLabel } from "@/lib/ticketing/system";
import { refusalText, snapshot, verdict, type TicketKind } from "@/lib/ticketing/rules";
import { workspaceView } from "@/lib/mobile/views";

export type DecisionOutcome = "ok" | "not_pending" | { ticket: string };

/**
 * A request whose ticket could not be checked when it was made is checked
 * again before it is approved. A ticket the system now refuses blocks the
 * approval; one it still can't check is approved, and the log says so.
 */
async function recheckTicketBeforeApproval(id: string): Promise<{ refused: string | null; unchecked: boolean }> {
  const g = await db.accessGrant.findUnique({
    where: { id },
    select: { ticketRef: true, ticketVerified: true, user: { select: { email: true, name: true } }, site: { select: { id: true, name: true } } },
  });
  if (!g?.ticketRef || g.ticketVerified) return { refused: null, unchecked: false };
  const sys = await loadTicketSystem();
  if (!checksTickets(sys)) return { refused: null, unchecked: false };
  const ws = await workspaceView().catch(() => ({ slug: null as string | null }));
  const r = await lookup(sys, g.ticketRef, { user: { email: g.user.email, name: g.user.name }, resource: g.site, workspace: ws.slug ?? "default" });
  if (!r.ok) return { refused: null, unchecked: true };
  const kind = sys.kind as TicketKind;
  const v = verdict(r.facts, { kind, allowedStates: sys.allowedStates, matchAssignee: sys.matchAssignee }, { email: g.user.email });
  if (!v.ok) return { refused: refusalText(v.why, v.detail, systemLabel(sys)), unchecked: false };
  await db.accessGrant.update({
    where: { id },
    data: grantTicketData({ ticketRef: g.ticketRef, ticket: snapshot(kind, r.facts), ticketVerified: true, ticketCheckedAt: new Date() }),
  });
  return { refused: null, unchecked: false };
}

/**
 * Approve or deny a pending access request, with everything that goes with
 * it: the admin audit row and the vendor's e-mail. Shared by the console and
 * the app so a decision means the same wherever it was made.
 */
export async function applyGrantDecision(input: {
  actor: { id: string; email: string };
  grantId: string;
  decision: "approve" | "deny";
  reason?: unknown;
  clientIp: string | null;
  via?: "app";
}): Promise<DecisionOutcome> {
  const { actor, grantId: id, decision } = input;
  const check = decision === "approve" ? await recheckTicketBeforeApproval(id) : { refused: null, unchecked: false };
  if (check.refused) return { ticket: check.refused };
  const count = await decideGrant(id, decision, actor.id, normalizeDenyReason(input.reason));
  if (count === 0) return "not_pending";

  await recordAdminAction({
    actor,
    action: decision === "approve" ? "grant.approve" : "grant.deny",
    targetType: "grant", targetId: id,
    summary: `${decision === "approve" ? "Approved" : "Denied"} access request ${id}${input.via === "app" ? " (Captivo Admin app)" : ""}${check.unchecked ? "; its ticket could not be checked" : ""}`,
    clientIp: input.clientIp,
  });

  if (await notifyEmailEnabled("access_decisions")) {
    try {
      const grant = await db.accessGrant.findUnique({
        where: { id },
        select: { user: { select: { email: true } }, site: { select: { name: true } } },
      });
      if (grant?.user?.email) {
        const m = accessDecisionEmail({
          decision: decision === "approve" ? "approved" : "denied",
          siteName: grant.site.name,
          consoleUrl: await consoleBaseUrl(),
        });
        await sendMail({ to: grant.user.email, subject: m.subject, html: m.html, text: m.text });
      }
    } catch {
      // Best-effort: emailing the vendor must never change the decision outcome.
    }
  }
  return "ok";
}
