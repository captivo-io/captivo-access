import { db } from "@/lib/db";
import { currentTenantId } from "@/lib/tenant/context";
import { listActiveSessions } from "@/lib/dataplane/client";

export interface TrendDay { date: string; allow: number; deny: number }
export interface Labeled { label: string; count: number }
export interface IpFlag { userEmail: string; ipCount: number }
export interface RefCount { id: string; label: string; count: number }

export type DailyCount = { day: string; count: number };
export type HourCell = { dow: number; hour: number; count: number };

export const IP_FLAG_THRESHOLD = 3;

// UTC YYYY-MM-DD keys, oldest→newest, ending on `now`'s UTC day.
export function zeroFillDays(now: Date, days = 30): string[] {
  const keys: string[] = [];
  const base = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(base);
    d.setUTCDate(base.getUTCDate() - i);
    keys.push(d.toISOString().slice(0, 10));
  }
  return keys;
}

// Distinct-vendor allow/deny day-counts mapped onto the zero-filled window.
export function buildTrend(allow: DailyCount[], deny: DailyCount[], now: Date, days = 30): TrendDay[] {
  const keys = zeroFillDays(now, days);
  const a = new Map(allow.map((r) => [r.day, r.count]));
  const d = new Map(deny.map((r) => [r.day, r.count]));
  return keys.map((k) => ({ date: k, allow: a.get(k) ?? 0, deny: d.get(k) ?? 0 }));
}

// Per-day allow (distinct vendors) series aligned to the given day keys.
export function seriesFor(days: string[], allow: DailyCount[]): number[] {
  const a = new Map(allow.map((r) => [r.day, r.count]));
  return days.map((k) => a.get(k) ?? 0);
}

// 7×24 grid from (dow,hour,count) cells; out-of-range cells skipped; reports max.
export function buildHeatmap(cells: HourCell[]): { grid: number[][]; max: number } {
  const grid: number[][] = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
  let max = 0;
  for (const c of cells) {
    if (c.dow < 0 || c.dow > 6 || c.hour < 0 || c.hour > 23) continue;
    grid[c.dow][c.hour] = c.count;
    if (c.count > max) max = c.count;
  }
  return { grid, max };
}

// id/label/count rows (already sorted+limited by SQL) → RefCount; label falls back to id.
export function toRefCounts(rows: { id: string; label: string | null; count: number }[]): RefCount[] {
  return rows.map((r) => ({ id: r.id, label: r.label ?? r.id, count: r.count }));
}

// accessMode/count rows → web/remote totals (GATEWAY = remote, else web).
export function buildTypeMix(rows: { accessMode: string; count: number }[]): { web: number; remote: number } {
  let web = 0, remote = 0;
  for (const r of rows) {
    if (r.accessMode === "GATEWAY") remote += r.count;
    else web += r.count;
  }
  return { web, remote };
}

// All DENY reason/count rows → total (sum of all) + top `limit` as Labeled.
export function toDenyReasons(rows: { reason: string; count: number }[], limit: number): { total: number; reasons: Labeled[] } {
  const total = rows.reduce((s, r) => s + r.count, 0);
  const reasons = [...rows]
    .sort((a, b) => b.count - a.count)
    .slice(0, limit)
    .map((r) => ({ label: r.reason, count: r.count }));
  return { total, reasons };
}

// Pass-through shape guard (SQL already applied the threshold + ordering).
export function toIpFlags(rows: { userEmail: string; ipCount: number }[]): IpFlag[] {
  return rows.map((r) => ({ userEmail: r.userEmail, ipCount: r.ipCount }));
}

// Recording volume in the window: count, total hours, average minutes.
export function sessionStats(recs: { startedAt: Date; lastEventAt: Date }[]): { recordings: number; totalHours: number; avgMinutes: number } {
  if (recs.length === 0) return { recordings: 0, totalHours: 0, avgMinutes: 0 };
  let totalMs = 0;
  for (const r of recs) totalMs += Math.max(0, r.lastEventAt.getTime() - r.startedAt.getTime());
  return {
    recordings: recs.length,
    totalHours: Math.round(totalMs / 3_600_000),
    avgMinutes: Math.round(totalMs / recs.length / 60_000),
  };
}

export interface Insights {
  trend: TrendDay[];
  heatmap: { grid: number[][]; max: number };
  topResources: RefCount[];
  topVendors: RefCount[];
  deny: { total: number; reasons: Labeled[] };
  ipFlags: IpFlag[];
  expiring: { count: number; soonest: { userEmail: string; siteName: string; endsAt: string }[] };
  activeSessions: { count: number; longestStartedAt: string | null };
  activeVendors: { count: number; series: number[] };
  typeMix: { web: number; remote: number };
  sessionStats: { recordings: number; totalHours: number; avgMinutes: number };
  topDenied: Labeled[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

export async function getInsights(now = new Date(), rangeDays = 30): Promise<Insights> {
  const since = new Date(now.getTime() - rangeDays * DAY_MS);
  const tenant = currentTenantId();
  const in7d = new Date(now.getTime() + 7 * DAY_MS);
  const expiringWhere = { status: "ACTIVE" as const, endsAt: { gte: now, lte: in7d } };

  const [
    vendorsByDay, totalVendorsRows, topResRows, topVenRows, typeMixRows,
    denyReasonRows, heatmapRows, ipFlagRows, topDeniedRows,
    expiringRows, expiringCount, active, recordings,
  ] = await Promise.all([
    db.$queryRaw<{ day: string; decision: string; n: bigint }[]>`
      SELECT to_char("timestamp", 'YYYY-MM-DD') AS day, "decision"::text AS decision, COUNT(DISTINCT "userId") AS n
      FROM "AuditEvent"
      WHERE "tenantId" = ${tenant} AND "timestamp" >= ${since} AND "userId" IS NOT NULL
      GROUP BY day, "decision"`,
    db.$queryRaw<{ n: bigint }[]>`
      SELECT COUNT(DISTINCT "userId") AS n FROM "AuditEvent"
      WHERE "tenantId" = ${tenant} AND "timestamp" >= ${since} AND "decision" = 'ALLOW' AND "userId" IS NOT NULL`,
    db.$queryRaw<{ id: string; label: string | null; n: bigint }[]>`
      SELECT "siteId" AS id, MAX("siteName") AS label, COUNT(DISTINCT to_char("timestamp", 'YYYY-MM-DD')) AS n
      FROM "AuditEvent"
      WHERE "tenantId" = ${tenant} AND "timestamp" >= ${since} AND "decision" = 'ALLOW' AND "siteId" IS NOT NULL
      GROUP BY "siteId" ORDER BY n DESC LIMIT 5`,
    db.$queryRaw<{ id: string; label: string | null; n: bigint }[]>`
      SELECT "userId" AS id, MAX("userEmail") AS label, COUNT(DISTINCT to_char("timestamp", 'YYYY-MM-DD')) AS n
      FROM "AuditEvent"
      WHERE "tenantId" = ${tenant} AND "timestamp" >= ${since} AND "decision" = 'ALLOW' AND "userId" IS NOT NULL
      GROUP BY "userId" ORDER BY n DESC LIMIT 5`,
    db.$queryRaw<{ accessMode: string; n: bigint }[]>`
      SELECT s."accessMode"::text AS "accessMode", COUNT(DISTINCT ("a"."userId", "a"."siteId")) AS n
      FROM "AuditEvent" a JOIN "Site" s ON s."id" = "a"."siteId"
      WHERE "a"."tenantId" = ${tenant} AND "a"."timestamp" >= ${since} AND "a"."decision" = 'ALLOW' AND "a"."userId" IS NOT NULL
      GROUP BY s."accessMode"`,
    db.$queryRaw<{ reason: string | null; n: bigint }[]>`
      SELECT COALESCE("reason", 'unspecified') AS reason, COUNT(*) AS n
      FROM "AuditEvent"
      WHERE "tenantId" = ${tenant} AND "timestamp" >= ${since} AND "decision" = 'DENY'
      GROUP BY reason ORDER BY n DESC`,
    db.$queryRaw<{ dow: number; hour: number; n: bigint }[]>`
      SELECT EXTRACT(DOW FROM "timestamp")::int AS dow, EXTRACT(HOUR FROM "timestamp")::int AS hour, COUNT(*) AS n
      FROM "AuditEvent"
      WHERE "tenantId" = ${tenant} AND "timestamp" >= ${since}
      GROUP BY dow, hour`,
    db.$queryRaw<{ userEmail: string; n: bigint }[]>`
      SELECT "userEmail", COUNT(DISTINCT "clientIp") AS n
      FROM "AuditEvent"
      WHERE "tenantId" = ${tenant} AND "timestamp" >= ${since} AND "userEmail" IS NOT NULL AND "clientIp" IS NOT NULL
      GROUP BY "userEmail" HAVING COUNT(DISTINCT "clientIp") >= ${IP_FLAG_THRESHOLD}
      ORDER BY n DESC`,
    db.$queryRaw<{ userEmail: string; n: bigint }[]>`
      SELECT "userEmail", COUNT(*) AS n
      FROM "AuditEvent"
      WHERE "tenantId" = ${tenant} AND "timestamp" >= ${since} AND "decision" = 'DENY' AND "userEmail" IS NOT NULL
      GROUP BY "userEmail" ORDER BY n DESC LIMIT 3`,
    db.accessGrant.findMany({
      where: expiringWhere,
      select: { endsAt: true, user: { select: { email: true } }, site: { select: { name: true } } },
      orderBy: { endsAt: "asc" },
      take: 5,
    }),
    db.accessGrant.count({ where: expiringWhere }),
    listActiveSessions(),
    db.sessionRecording.findMany({ where: { startedAt: { gte: since } }, select: { startedAt: true, lastEventAt: true } }),
  ]);

  const days = zeroFillDays(now, rangeDays);
  const allowByDay: DailyCount[] = vendorsByDay.filter((r) => r.decision === "ALLOW").map((r) => ({ day: r.day, count: Number(r.n) }));
  const denyByDay: DailyCount[] = vendorsByDay.filter((r) => r.decision === "DENY").map((r) => ({ day: r.day, count: Number(r.n) }));
  const longestStartedAt = active.length ? [...active].map((a) => a.startedAt).sort()[0] : null;

  return {
    trend: buildTrend(allowByDay, denyByDay, now, rangeDays),
    heatmap: buildHeatmap(heatmapRows.map((r) => ({ dow: r.dow, hour: r.hour, count: Number(r.n) }))),
    topResources: toRefCounts(topResRows.map((r) => ({ id: r.id, label: r.label, count: Number(r.n) }))),
    topVendors: toRefCounts(topVenRows.map((r) => ({ id: r.id, label: r.label, count: Number(r.n) }))),
    deny: toDenyReasons(denyReasonRows.map((r) => ({ reason: r.reason ?? "unspecified", count: Number(r.n) })), 5),
    ipFlags: toIpFlags(ipFlagRows.map((r) => ({ userEmail: r.userEmail, ipCount: Number(r.n) }))),
    expiring: {
      count: expiringCount,
      soonest: expiringRows.map((g) => ({
        userEmail: g.user.email ?? "—",
        siteName: g.site.name,
        endsAt: (g.endsAt as Date).toISOString(),
      })),
    },
    activeSessions: { count: active.length, longestStartedAt },
    activeVendors: { count: totalVendorsRows.length ? Number(totalVendorsRows[0].n) : 0, series: seriesFor(days, allowByDay) },
    typeMix: buildTypeMix(typeMixRows.map((r) => ({ accessMode: r.accessMode, count: Number(r.n) }))),
    sessionStats: sessionStats(recordings),
    topDenied: topDeniedRows.map((r) => ({ label: r.userEmail, count: Number(r.n) })),
  };
}
