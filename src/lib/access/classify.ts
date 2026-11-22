import { parseSchedule, isWithinSchedule } from "./schedule";

// One grant's verdict at a moment. Db-free, so client components (the Grants
// page) can share it with the access check in evaluate.ts.

export type DecisionReason =
  | "allow" | "user_disabled" | "no_grant"
  | "revoked" | "denied" | "not_yet" | "off_schedule" | "expired" | "pending_approval";

export interface Decision { allow: boolean; reason: DecisionReason }

export interface GrantWindow {
  status: "ACTIVE" | "REVOKED" | "DENIED";
  startsAt: Date | null;
  endsAt: Date | null;
  requiresApproval: boolean;
  approvedAt: Date | null;
  schedule: unknown;
}

export function classifyGrant(g: GrantWindow, now: Date): DecisionReason {
  if (g.status === "REVOKED") return "revoked";
  if (g.status === "DENIED") return "denied";
  if (g.endsAt && now > g.endsAt) return "expired";
  // Undecided before not-yet-started: a request for a later window is still a
  // request waiting on someone, not access that is scheduled.
  if (g.requiresApproval && !g.approvedAt) return "pending_approval";
  if (g.startsAt && now < g.startsAt) return "not_yet";
  if (g.schedule != null) {
    const s = parseSchedule(g.schedule);
    // Fail closed: a present-but-unparseable schedule denies, never silently allows.
    if (s === null || !isWithinSchedule(s, now)) return "off_schedule";
  }
  return "allow";
}
