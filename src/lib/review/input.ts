import { DUE_DAYS, RECURRENCES, type Decision, type Recurrence } from "./plan";

/** Validates a new review from the console's dialog. */
export function reviewInput(b: Record<string, unknown>): { name: string; siteIds: string[]; dueDays: number; onNoAnswer: "revoke" | "keep"; recurrence: Recurrence | null; opensAt: Date | null } | { error: string } {
  const name = typeof b.name === "string" ? b.name.trim() : "";
  if (!name || name.length > 80) return { error: "invalid_name" };
  const siteIds = Array.isArray(b.siteIds) ? [...new Set(b.siteIds.filter((s): s is string => typeof s === "string" && s.length > 0))] : [];
  const dueDays = Number(b.dueDays);
  if (!(DUE_DAYS as readonly number[]).includes(dueDays)) return { error: "invalid_due" };
  const onNoAnswer = b.onNoAnswer === "keep" ? "keep" : "revoke";
  const recurrence = (RECURRENCES as readonly string[]).includes(b.recurrence as string) ? (b.recurrence as Recurrence) : null;
  let opensAt: Date | null = null;
  if (typeof b.opensAt === "string" && b.opensAt) {
    opensAt = new Date(b.opensAt);
    if (Number.isNaN(opensAt.getTime())) return { error: "invalid_date" };
  }
  return { name, siteIds, dueDays, onNoAnswer, recurrence, opensAt };
}

export function decisionInput(b: Record<string, unknown>): { itemIds: string[]; decision: Decision | null; limitTo: Date | null } | { error: string } {
  const itemIds = Array.isArray(b.itemIds) ? b.itemIds.filter((s): s is string => typeof s === "string").slice(0, 2000) : [];
  if (itemIds.length === 0) return { error: "no_items" };
  const decision = b.decision === null ? null : ["keep", "revoke", "limit", "ad_remove"].includes(b.decision as string) ? (b.decision as Decision) : undefined;
  if (decision === undefined) return { error: "invalid_decision" };
  let limitTo: Date | null = null;
  if (decision === "limit") {
    limitTo = typeof b.limitTo === "string" ? new Date(b.limitTo) : null;
    if (!limitTo || Number.isNaN(limitTo.getTime())) return { error: "invalid_date" };
  }
  return { itemIds, decision, limitTo };
}
