import { classifyGrant, type DecisionReason } from "@/lib/access/classify";

// How the Grants page sorts and counts grants. Pure + db-free so the page, the
// CSV export and the tests share one definition.

export type GrantKind = "permanent" | "timed" | "recurring";
/** active: lets the user in now; scheduled: not started yet, or outside its hours; ended: expired, revoked or denied. */
export type GrantState = "active" | "scheduled" | "ended" | "pending";
export type GrantFilter = "all" | "active" | "perm" | "scheduled" | "ended" | "soon";

export const GRANT_FILTERS: GrantFilter[] = ["all", "active", "perm", "scheduled", "ended", "soon"];

export interface GrantFacts {
  status: "ACTIVE" | "REVOKED" | "DENIED";
  startsAt: Date | null;
  endsAt: Date | null;
  schedule: unknown;
  requiresApproval: boolean;
  approvedAt: Date | null;
}

const DAY_MS = 86_400_000;

export function grantKind(g: Pick<GrantFacts, "endsAt" | "schedule">): GrantKind {
  if (g.schedule != null) return "recurring";
  return g.endsAt ? "timed" : "permanent";
}

export function grantState(g: GrantFacts, now: Date): { state: GrantState; reason: DecisionReason } {
  const reason = classifyGrant(g, now);
  switch (reason) {
    case "allow": return { state: "active", reason };
    case "not_yet":
    case "off_schedule": return { state: "scheduled", reason };
    case "pending_approval": return { state: "pending", reason };
    default: return { state: "ended", reason };
  }
}

/** Live (active or scheduled) and without an end date. */
export function isPermanent(g: Pick<GrantFacts, "endsAt">, state: GrantState): boolean {
  return (state === "active" || state === "scheduled") && !g.endsAt;
}

/** Live and ending within the next 24 hours. */
export function endsSoon(g: Pick<GrantFacts, "endsAt">, state: GrantState, now: Date): boolean {
  if (state !== "active" && state !== "scheduled") return false;
  if (!g.endsAt) return false;
  const left = g.endsAt.getTime() - now.getTime();
  return left > 0 && left <= DAY_MS;
}

export interface GrantTally { userId: string; state: GrantState; permanent: boolean; soon: boolean }

export function matchesFilter(g: GrantTally, f: GrantFilter): boolean {
  switch (f) {
    case "all": return g.state !== "pending";
    case "active": return g.state === "active";
    case "perm": return g.permanent;
    case "scheduled": return g.state === "scheduled";
    case "ended": return g.state === "ended";
    case "soon": return g.soon;
  }
}

export function grantKpis(rows: GrantTally[]) {
  const count = (f: GrantFilter) => rows.filter((r) => matchesFilter(r, f)).length;
  return {
    all: count("all"),
    active: count("active"),
    activePeople: new Set(rows.filter((r) => r.state === "active").map((r) => r.userId)).size,
    perm: count("perm"),
    scheduled: count("scheduled"),
    ended: count("ended"),
    soon: count("soon"),
    /** Live grants: the "of n" in the permanent-grants banner. */
    live: rows.filter((r) => r.state === "active" || r.state === "scheduled").length,
  };
}

/** The permanent-grants banner shows from this many on. */
export const PERMANENT_HINT_AT = 5;

/**
 * "Limit to n days": the end date a grant gets, or null when it already ends
 * by then (an earlier end is never pushed out).
 */
export function limitedEndsAt(endsAt: Date | null, now: Date, days: number): Date | null {
  const limit = new Date(now.getTime() + days * DAY_MS);
  if (endsAt && endsAt <= limit) return null;
  return limit;
}

/** The longest "limit to" a policy cap allows: the cap when it is under the asked days. */
export function limitDays(asked: number, maxGrantDays: number): number {
  return maxGrantDays > 0 ? Math.min(asked, maxGrantDays) : asked;
}
