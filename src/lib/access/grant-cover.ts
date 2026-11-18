// Whether a grant someone already has makes a new one pointless: the existing
// grant is live, has no recurring hours, starts no later and ends no earlier
// than the new one would. A narrower existing grant (recurring hours, an end
// date, a later start) can still be widened by a second grant, so that stays
// allowed. Pure + db-free: the grants dialog and the API share it.

export interface CoverWindow {
  /** ms; null = from creation / right away. */
  startsAt: number | null;
  /** ms; null = no end. */
  endsAt: number | null;
  recurring: boolean;
}

export function grantCovers(existing: CoverWindow, proposed: CoverWindow, now: number): boolean {
  if (existing.recurring) return false;
  const exStart = existing.startsAt ?? -Infinity;
  const newStart = proposed.startsAt ?? now;
  if (exStart > newStart) return false;
  if (existing.endsAt === null) return true;
  if (existing.endsAt <= now) return false; // already over
  return proposed.endsAt !== null && existing.endsAt >= proposed.endsAt;
}

/** A grant that can still let the person in (not revoked, denied, expired or awaiting approval). */
export function grantIsLive(g: { status: string; endsAt: Date | null; requiresApproval: boolean; approvedAt: Date | null }, now: number): boolean {
  if (g.status !== "ACTIVE") return false;
  if (g.endsAt && g.endsAt.getTime() <= now) return false;
  return !(g.requiresApproval && !g.approvedAt);
}
