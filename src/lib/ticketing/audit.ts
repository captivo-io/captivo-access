import { recordAdminAction, type AdminActor } from "@/lib/audit/admin";

// Admin-audit rows for what the ticket system decided, so the log says that a
// ticket, not a person, opened or ended the access.

export const TICKET_ACTOR: AdminActor = { id: "system", email: null };

export function ticketApprovalAudit(grantId: string, ref: string, system: string, what: string) {
  return recordAdminAction({
    actor: TICKET_ACTOR, action: "grant.approve", targetType: "grant", targetId: grantId,
    summary: `Approved access request ${grantId} (${what}): ticket ${ref} is approved in ${system}`,
    metadata: { ticket: ref },
  });
}

export function ticketRevokeAudit(grantId: string, ref: string, why: string, what: string) {
  return recordAdminAction({
    actor: TICKET_ACTOR, action: "grant.revoke", targetType: "grant", targetId: grantId,
    summary: `Revoked ${what}: ${why} (ticket ${ref})`,
    metadata: { ticket: ref },
  });
}
