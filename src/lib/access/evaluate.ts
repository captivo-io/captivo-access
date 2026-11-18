import { db } from "@/lib/db";

export { classifyGrant, type DecisionReason, type Decision, type GrantWindow } from "./classify";
import { classifyGrant, type Decision } from "./classify";

// Deny-reason priority when multiple grants all deny: show the most "promising"
// reason (soonest/most-actionable) → pending_approval > not_yet > off_schedule > expired > revoked/denied.
// (no_grant and user_disabled are handled before this table, never compared here.)
const DENY_PRIORITY: Record<"pending_approval" | "not_yet" | "off_schedule" | "expired" | "revoked" | "denied", number> = {
  pending_approval: 5, not_yet: 4, off_schedule: 3, expired: 2, revoked: 1, denied: 1,
};

export async function evaluateAccess(userId: string, siteId: string, now: Date): Promise<Decision> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { status: true } });
  if (!user || user.status !== "ACTIVE") return { allow: false, reason: "user_disabled" };

  const grants = await db.accessGrant.findMany({ where: { userId, siteId } });
  if (grants.length === 0) return { allow: false, reason: "no_grant" };

  let best: "pending_approval" | "not_yet" | "off_schedule" | "expired" | "revoked" | "denied" | null = null;
  for (const g of grants) {
    const d = classifyGrant(g, now);
    if (d === "allow") return { allow: true, reason: "allow" };
    const dd = d as "pending_approval" | "not_yet" | "off_schedule" | "expired" | "revoked" | "denied";
    if (best === null || DENY_PRIORITY[dd] > DENY_PRIORITY[best]) best = dd;
  }
  return { allow: false, reason: best! };
}
