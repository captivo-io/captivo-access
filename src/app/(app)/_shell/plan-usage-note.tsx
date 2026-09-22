import { planUsageText, type PlanUsage } from "@/lib/platform/plan-usage";

/**
 * The allowance line under a page title. Renders nothing when there is no cap
 * (self-hosted, or a plan without one) -- see lib/platform/plan-usage.ts.
 */
export function PlanUsageNote({ usage, noun }: { usage: PlanUsage | null; noun: string }) {
  if (!usage) return null;
  const atCap = usage.used >= usage.max;
  return (
    <p className={atCap ? "plan-usage plan-usage-at-cap" : "plan-usage"}>
      {planUsageText(usage, noun)}
    </p>
  );
}
