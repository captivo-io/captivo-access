import { listTenants, PURGE_AFTER_DAYS, type PlatformTenant } from "@/lib/platform/tenants";
import { tenantStats, cronRuns, recentAdminEvents, recentAccessEvents, type TenantStats } from "@/lib/platform/sql";
import { tenantsHealth, healthProblems, type TenantHealth } from "@/lib/platform/health";

export type AlertLevel = "info" | "warn" | "danger";
export interface PlatformAlert {
  level: AlertLevel;
  kind: string;
  tenant?: { id: string; slug: string; name: string };
  text: string;
  href?: string;
}

const STALE_HEARTBEAT_MS = 20 * 60_000; // site-health runs every 5 min
const STALE_DAILY_MS = 26 * 3600_000;
const DAILY_JOBS = ["audit-retention", "recording-retention", "audit-anchor"];

export interface TenantRow extends PlatformTenant {
  stats: TenantStats | null;
  health: TenantHealth | null;
  cron: { heartbeatAt: Date | null; stale: boolean };
  problems: string[];
}

// One pass that everything on the platform console builds on: tenants joined
// with their stats, provisioning health and cron heartbeat, plus the derived alerts.
export async function platformSnapshot(opts: { health?: boolean } = {}): Promise<{ tenants: TenantRow[]; alerts: PlatformAlert[]; totals: Totals }> {
  const [tenants, stats, runs] = await Promise.all([listTenants(), tenantStats(), cronRuns()]);
  const live = tenants.filter((t) => !t.deletedAt);
  const health = opts.health === false ? new Map<string, TenantHealth>() : await tenantsHealth(live.filter((t) => t.status === "ACTIVE").map((t) => t.slug));
  const now = Date.now();

  const rows: TenantRow[] = tenants.map((t) => {
    const hb = runs.find((r) => r.tenantId === t.id && r.job === "site-health")?.ranAt ?? null;
    const isNew = now - t.createdAt.getTime() < STALE_HEARTBEAT_MS;
    const stale = t.status === "ACTIVE" && !t.deletedAt && !isNew && (hb === null || now - new Date(hb).getTime() > STALE_HEARTBEAT_MS);
    const h = health.get(t.slug) ?? null;
    const problems = h ? healthProblems(h) : [];
    if (stale) problems.push("background jobs not running");
    return { ...t, stats: stats.get(t.id) ?? null, health: h, cron: { heartbeatAt: hb ? new Date(hb) : null, stale }, problems };
  });

  const alerts: PlatformAlert[] = [];
  for (const t of rows) {
    const ref = { id: t.id, slug: t.slug, name: t.name };
    const href = `/platform/tenants/${t.id}`;
    if (t.deletedAt) {
      const days = Math.max(0, PURGE_AFTER_DAYS - Math.floor((now - t.deletedAt.getTime()) / 86_400_000));
      alerts.push({ level: "info", kind: "deleted", tenant: ref, text: `Deleted — purged in ${days} day${days === 1 ? "" : "s"}`, href });
      continue;
    }
    if (t.status === "SUSPENDED") alerts.push({ level: "info", kind: "suspended", tenant: ref, text: "Suspended", href });
    if (t.health) {
      for (const p of healthProblems(t.health)) alerts.push({ level: t.health.cert === "expiring" ? "warn" : "danger", kind: "provisioning", tenant: ref, text: p, href: "/platform/jobs" });
    }
    if (t.cron.stale) alerts.push({ level: "warn", kind: "cron_stale", tenant: ref, text: t.cron.heartbeatAt ? "Background jobs stale (no heartbeat in 20 min)" : "Background jobs never ran", href: "/platform/jobs" });
    if (t.status === "ACTIVE") {
      for (const job of DAILY_JOBS) {
        const r = runs.find((x) => x.tenantId === t.id && x.job === job);
        if (r && now - new Date(r.ranAt).getTime() > STALE_DAILY_MS) alerts.push({ level: "warn", kind: "cron_daily_stale", tenant: ref, text: `${job} last ran ${Math.floor((now - new Date(r.ranAt).getTime()) / 3600_000)}h ago`, href: "/platform/jobs" });
      }
    }
    if (t.stats && t.stats.sites > 0 && t.stats.connectors > 0 && t.stats.connectorsOnline === 0 && t.status === "ACTIVE") {
      alerts.push({ level: "warn", kind: "connectors_offline", tenant: ref, text: "All connectors offline", href });
    }
  }
  const order: Record<AlertLevel, number> = { danger: 0, warn: 1, info: 2 };
  alerts.sort((a, b) => order[a.level] - order[b.level]);

  return { tenants: rows, alerts, totals: totalsOf(rows) };
}

export interface Totals {
  tenants: number; active: number; suspended: number; deleted: number;
  users: number; vendors: number; sessions24h: number; connectors: number; connectorsOnline: number;
  sites: number; grantsActive: number; requestsPending: number; recordings: number; recordingBytes: number; auditEvents: number;
}
function totalsOf(rows: TenantRow[]): Totals {
  const t: Totals = { tenants: 0, active: 0, suspended: 0, deleted: 0, users: 0, vendors: 0, sessions24h: 0, connectors: 0, connectorsOnline: 0, sites: 0, grantsActive: 0, requestsPending: 0, recordings: 0, recordingBytes: 0, auditEvents: 0 };
  for (const r of rows) {
    if (r.deletedAt) { t.deleted++; continue; }
    t.tenants++;
    if (r.status === "ACTIVE") t.active++; else t.suspended++;
    if (r.stats) {
      t.users += r.stats.users; t.vendors += r.stats.vendors; t.sessions24h += r.stats.sessions24h; t.connectors += r.stats.connectors;
      t.connectorsOnline += r.stats.connectorsOnline; t.sites += r.stats.sites; t.grantsActive += r.stats.grantsActive; t.requestsPending += r.stats.requestsPending;
      t.recordings += r.stats.recordings; t.recordingBytes += r.stats.recordingBytes; t.auditEvents += r.stats.auditEvents;
    }
  }
  return t;
}

// Cheap variant for the layout badge (no DNS/TLS probes).
export async function platformAlerts(): Promise<PlatformAlert[]> {
  return (await platformSnapshot({ health: false })).alerts;
}

export async function recentActivity(limit = 12) {
  const [admin, access] = await Promise.all([recentAdminEvents(limit, null), recentAccessEvents(limit, null)]);
  return { admin, access };
}
