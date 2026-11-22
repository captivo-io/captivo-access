import { db } from "@/lib/db";
import { currentTenantId } from "@/lib/tenant/context";
import { getPlatformSettings } from "@/lib/settings/platform";

export type CronJob = "site-health" | "audit-retention" | "recording-retention" | "audit-anchor" | "access-reviews";
// Platform-level (Cloud) maintenance job; recorded under the platform tenant only.
export type PlatformJob = "platform-ops";

// recordCronRun stamps a heartbeat for a cron endpoint. Called on every
// authorized hit (even a no-op run) so "the cron is scheduled" is provable.
// Best-effort — never fails the cron itself.
export async function recordCronRun(job: CronJob | PlatformJob): Promise<void> {
  await db.cronRun
    .upsert({ where: { tenantId_job: { tenantId: currentTenantId(), job } }, create: { tenantId: currentTenantId(), job, ranAt: new Date() }, update: { ranAt: new Date() } })
    .catch(() => {});
}

export interface CronHealth {
  anyRun: boolean; // has ANY cron ever run? (proves the scheduler works)
  stale: { job: CronJob; lastRunAt: Date | null }[]; // relevant jobs overdue / never run
}

// cronHealth reports whether the expected background jobs appear to be running.
// A job is only flagged when it's actually relevant (site-health only with
// sites; recording-retention only when a retention window is set), so a banner
// never nags about a feature you don't use.
export async function cronHealth(): Promise<CronHealth> {
  let runs: { job: string; ranAt: Date }[] = [];
  let siteCount = 0;
  let recRetention = 0;
  let anchorOn = false;
  try {
    [runs, siteCount] = await Promise.all([
      db.cronRun.findMany({ select: { job: true, ranAt: true } }),
      db.site.count(),
    ]);
    const settings = await getPlatformSettings();
    recRetention = settings.recordingRetentionDays ?? 0;
    anchorOn = settings.externalAnchorEnabled === true;
  } catch {
    return { anyRun: true, stale: [] }; // table missing / DB hiccup: don't alarm
  }

  const last = (j: CronJob): Date | null => runs.find((r) => r.job === j)?.ranAt ?? null;
  const now = Date.now();
  const agedOut = (d: Date, ms: number) => now - d.getTime() > ms;

  // site-health is the scheduler heartbeat: it runs every 5 min and stamps a
  // heartbeat on every hit (regardless of how many sites exist). If it's fresh,
  // the cron IS running — so a daily job that simply hasn't hit its time yet is
  // NOT flagged (avoids a false alarm right after deploy). If site-health is
  // stale/never, the scheduler itself looks down — the umbrella warning.
  const siteHealth = last("site-health");
  const schedulerHealthy = siteHealth !== null && !agedOut(siteHealth, 20 * 60_000);

  const stale: CronHealth["stale"] = [];
  if (!schedulerHealthy) {
    stale.push({ job: "site-health", lastRunAt: siteHealth });
  } else {
    // Scheduler proven working; only flag a daily job that ran before but has
    // since stopped firing (a real regression), not one that's merely new.
    const a = last("audit-retention");
    if (a && agedOut(a, 26 * 3600_000)) stale.push({ job: "audit-retention", lastRunAt: a });
    const r = last("recording-retention");
    if (recRetention > 0 && r && agedOut(r, 26 * 3600_000)) stale.push({ job: "recording-retention", lastRunAt: r });
    // audit-anchor is opt-in: only warn when the feature is enabled, so a disabled
    // feature never raises a stale-job banner.
    const an = last("audit-anchor");
    if (anchorOn && an && agedOut(an, 26 * 3600_000)) stale.push({ job: "audit-anchor", lastRunAt: an });
  }

  return { anyRun: runs.length > 0, stale };
}
