import { db } from "@/lib/db";
import { onboardingDismissedAt } from "@/lib/settings/platform";

export type OnboardingFacts = {
  /** A connector has come online at least once (it may be offline now). */
  connectorOnline: boolean;
  resources: number;
  grants: number;
  /** The tenant's first grant; drives how long the "Setup complete" band stays. */
  firstGrantAt: Date | null;
  dismissedAt: Date | null;
};

export type OnboardingView = {
  show: boolean;
  /** Per step: connector, resource, grant. */
  done: [boolean, boolean, boolean];
  count: number;
  /** The first step still open; -1 when all are done. */
  current: number;
  complete: boolean;
};

/** A finished setup keeps its "Setup complete" band this long, then the Console takes over. */
export const COMPLETE_BAND_MS = 7 * 86_400_000;

export function onboardingView(f: OnboardingFacts, now: Date): OnboardingView {
  const done: [boolean, boolean, boolean] = [f.connectorOnline, f.resources > 0, f.grants > 0];
  const count = done.filter(Boolean).length;
  const complete = count === 3;
  const current = done.indexOf(false);
  // Tenants that finished before the band existed must not see it again.
  const recent = !!f.firstGrantAt && now.getTime() - f.firstGrantAt.getTime() < COMPLETE_BAND_MS;
  const show = !f.dismissedAt && (!complete || recent);
  return { show, done, count, current, complete };
}

export async function getOnboardingFacts(): Promise<OnboardingFacts> {
  const [connectorOnline, resources, grants, first, dismissedAt] = await Promise.all([
    db.connector.count({ where: { OR: [{ lastSeenAt: { not: null } }, { status: "ONLINE" }] } }),
    db.site.count(),
    db.accessGrant.count(),
    db.accessGrant.findFirst({ orderBy: { createdAt: "asc" }, select: { createdAt: true } }),
    onboardingDismissedAt(),
  ]);
  return { connectorOnline: connectorOnline > 0, resources, grants, firstGrantAt: first?.createdAt ?? null, dismissedAt };
}
