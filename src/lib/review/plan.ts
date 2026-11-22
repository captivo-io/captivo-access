// Access reviews, the pure part: when a review opens and is due, what a
// decision may be, and what happens to an item when the review closes. The
// database side is ./store.ts.

export const RECURRENCES = ["quarterly", "semiannual", "yearly"] as const;
export type Recurrence = (typeof RECURRENCES)[number];
export const DUE_DAYS = [7, 14, 30] as const;

export type Decision = "keep" | "revoke" | "limit" | "ad_remove";
export type Outcome = "kept" | "revoked" | "limited" | "auto_revoked" | "unanswered" | "ad_remove" | "gone";

/** A grant unused this long is suggested for removal. */
export const STALE_DAYS = 90;

const MONTHS: Record<Recurrence, number> = { quarterly: 3, semiannual: 6, yearly: 12 };

export const RECURRENCE_LABEL: Record<Recurrence, string> = { quarterly: "Every 3 months", semiannual: "Every 6 months", yearly: "Every year" };

/** The next opening after `from` for a recurring review. */
export function nextOpening(from: Date, r: Recurrence): Date {
  const d = new Date(from);
  d.setUTCMonth(d.getUTCMonth() + MONTHS[r]);
  return d;
}

export function dueAt(openedAt: Date, dueDays: number): Date {
  return new Date(openedAt.getTime() + dueDays * 86_400_000);
}

export function isStale(lastUsedAt: Date | null, openedAt: Date): boolean {
  return !lastUsedAt || openedAt.getTime() - lastUsedAt.getTime() > STALE_DAYS * 86_400_000;
}

/**
 * Whether a reviewer may record this decision on this item. Nobody decides on
 * their own access, and a grant that comes from a directory group can't be
 * revoked here (the next sign-in would bring it back): it is kept or marked
 * for removal from the group.
 */
export function decisionAllowed(item: { userId: string; directoryManaged: boolean }, reviewerId: string, d: Decision): string | null {
  if (item.userId === reviewerId) return "own_access";
  if (item.directoryManaged && (d === "revoke" || d === "limit")) return "directory_managed";
  if (!item.directoryManaged && d === "ad_remove") return "not_directory";
  return null;
}

/** Roles that approve access: their own grants are never removed for silence. */
export const REVIEWER_ROLES = ["ADMIN", "OPERATOR"] as const;

/**
 * What closing does with an item, from its decision and the review's rule for
 * silence. Silence never removes a directory grant (the group would give it
 * back) or a reviewer's own (nobody else may have been there to decide, and
 * they can grant themselves access again anyway).
 */
export function outcomeFor(item: { decision: string | null; directoryManaged: boolean; userRole?: string | null }, onNoAnswer: string): Outcome {
  switch (item.decision) {
    case "keep": return "kept";
    case "revoke": return "revoked";
    case "limit": return "limited";
    case "ad_remove": return "ad_remove";
  }
  if (onNoAnswer === "revoke" && !item.directoryManaged && !(REVIEWER_ROLES as readonly string[]).includes(item.userRole ?? "")) return "auto_revoked";
  return "unanswered";
}

/** Reminder bits not yet sent that are due now: 1 a week before, 2 a day before. */
export function remindersDue(due: Date, sent: number, now: Date): number {
  const left = due.getTime() - now.getTime();
  let bits = 0;
  if (left <= 7 * 86_400_000 && left > 86_400_000 && !(sent & 1)) bits |= 1;
  if (left <= 86_400_000 && left > 0 && !(sent & 2)) bits |= 2;
  return bits;
}

export type ReviewSummary = Partial<Record<Outcome, number>> & { total: number };

export function summarize(outcomes: Outcome[]): ReviewSummary {
  const s: ReviewSummary = { total: outcomes.length };
  for (const o of outcomes) s[o] = (s[o] ?? 0) + 1;
  return s;
}

export const OUTCOME_LABEL: Record<Outcome, string> = {
  kept: "Kept", revoked: "Revoked", limited: "Limited", auto_revoked: "Revoked (no answer)",
  unanswered: "No answer", ad_remove: "Remove from directory group", gone: "Ended before close",
};

type CsvItem = {
  userLabel: string; userEmail: string | null; userRole: string | null; siteName: string; grantCreatedAt: Date; grantedBy: string | null;
  grantEndsAt: Date | null; directoryManaged: boolean; lastUsedAt: Date | null; decision: string | null; limitTo: Date | null;
  decidedByLabel: string | null; decidedAt: Date | null; outcome: string | null;
};

/** A review as CSV, one line per grant: the evidence an auditor asks for. Pure. */
export function reviewToCsv(items: CsvItem[], esc: (v: string) => string): string {
  const iso = (d: Date | null) => (d ? d.toISOString() : "");
  const head = ["user", "email", "role", "resource", "granted", "granted_by", "ends", "source", "last_used", "decision", "limit_to", "decided_by", "decided_at", "outcome"];
  const lines = [head.join(",")];
  for (const i of items) {
    lines.push([
      i.userLabel, i.userEmail ?? "", i.userRole ?? "", i.siteName, iso(i.grantCreatedAt), i.grantedBy ?? "", iso(i.grantEndsAt),
      i.directoryManaged ? "directory group" : "grant", iso(i.lastUsedAt), i.decision ?? "", iso(i.limitTo), i.decidedByLabel ?? "", iso(i.decidedAt),
      i.outcome ? OUTCOME_LABEL[i.outcome as Outcome] ?? i.outcome : "",
    ].map((v) => esc(v)).join(","));
  }
  return lines.join("\n") + "\n";
}
