import { planUsageHeadline, planUsageLevel, planUsageText, PLANS_URL, type PlanUsage } from "@/lib/platform/plan-usage";

/**
 * The allowance under a page title. Renders nothing when there is no cap
 * (self-hosted, or a plan without one) -- see lib/platform/plan-usage.ts.
 *
 * At rest it is a quiet meter. One before the cap it says so; at the cap --
 * the only state where the next click fails -- it becomes a band that says
 * what to do, with the way to more.
 */
export function PlanUsageNote({ usage, noun, one }: { usage: PlanUsage | null; noun: string; one?: string }) {
  if (!usage) return null;
  const level = planUsageLevel(usage);
  const pct = Math.min(100, Math.round((usage.used / Math.max(usage.max, 1)) * 100));
  const headline = planUsageHeadline(usage, noun, one ?? noun.replace(/s$/, ""));
  if (level === "ok" || !headline) {
    return (
      <p className="plan-usage">
        <span className="plan-meter" aria-hidden="true"><span style={{ width: `${pct}%` }} /></span>
        {planUsageText(usage, noun)}
      </p>
    );
  }
  return (
    <div className={`plan-band ${level}`} role={level === "full" ? "alert" : "status"}>
      <span className="plan-band-ic" aria-hidden="true">{level === "full" ? "!" : "i"}</span>
      <span className="plan-band-t">
        <b>{headline}</b>
        <span>
          {usage.used} of {usage.max} {usage.max === 1 ? one ?? noun : noun} used. {level === "full" ? "Remove one, or upgrade to add another." : "Upgrade before you need more."}
        </span>
      </span>
      <span className="plan-meter lg" aria-hidden="true"><span style={{ width: `${pct}%` }} /></span>
      <a className="btn sm plan-band-cta" href={PLANS_URL} target="_blank" rel="noreferrer">See plans</a>
    </div>
  );
}
