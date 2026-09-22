import { tenantEnvelope } from "@/lib/tenant/envelope";
import { currentTenantId } from "@/lib/tenant/context";
import { multiTenantEnabled } from "@/lib/tenant/enabled";
import { db } from "@/lib/db";
import type { LimitKey } from "@/lib/platform/tenant-shape";

/**
 * How much of a capped allowance this workspace has used.
 *
 * WHY THIS EXISTS. The limits were already enforced -- adding one connector
 * past the cap throws -- but nothing anywhere SHOWED them. Someone on the free
 * tier learned their allowance by hitting it, in an error message, mid-task.
 * An allowance you can only discover by failing is not an allowance, it is a
 * trap.
 *
 * Null means "no cap to talk about", and that covers two different situations
 * on purpose: a self-hosted installation, where the tenant machinery is a
 * no-op and nothing is limited, and a cloud plan with no cap on this key. In
 * both, a usage line would be noise at best and wrong at worst.
 */
export interface PlanUsage {
  used: number;
  max: number;
  /** The workspace's plan, for naming the allowance in the UI. */
  plan: string | null;
}

export async function planUsage(key: LimitKey, used: number): Promise<PlanUsage | null> {
  if (!multiTenantEnabled()) return null;

  const { limits } = await tenantEnvelope();
  const max = limits[key];
  if (max === undefined) return null;

  // The plan name is read separately from the envelope, which deliberately
  // carries only limits and capabilities. A failure here must not cost the
  // usage line -- the numbers are the point, the plan name is the label.
  let plan: string | null = null;
  try {
    const t = await db.tenant.findUnique({ where: { id: currentTenantId() }, select: { plan: true } });
    plan = t?.plan ?? null;
  } catch {
    plan = null;
  }

  return { used, max, plan };
}

/**
 * The sentence shown under a page title.
 *
 * Reads as a fact at rest ("2 of 5 resources used") and as a warning only when
 * it IS one -- at the cap, where the next click fails. A line that shouts at
 * every count teaches people to ignore it.
 */
export function planUsageText(usage: PlanUsage, noun: string): string {
  const label = usage.plan === "free" ? "Free plan" : "Your plan";
  const atCap = usage.used >= usage.max;
  const head = `${label}: ${usage.used} of ${usage.max} ${noun} used`;
  return atCap ? `${head} — remove one or upgrade to add another.` : head;
}
