import { db } from "@/lib/db";
import { currentTenantId } from "@/lib/tenant/context";

export interface RecordingKpis {
  /** Recordings started in the last 7 days, and on how many resources. */
  week: number;
  weekSites: number;
  /** Their total length; a recording its connector has not measured yet counts its span. */
  weekMs: number;
  /** All recordings still kept (erasures asked for are not counted). */
  bytes: number;
  /** Sessions that closed at once, any time. */
  empty: number;
  /** Per tab, for the type filter's counts. */
  byType: { all: number; web: number; rdp: number; ssh: number; sql: number };
}

export async function recordingKpis(now: Date = new Date()): Promise<RecordingKpis> {
  const tenant = currentTenantId();
  const since = new Date(now.getTime() - 7 * 86_400_000);
  const [week, kept, empty, types] = await Promise.all([
    db.$queryRaw<{ n: bigint; sites: bigint; ms: number | null }[]>`
      SELECT COUNT(*) AS n, COUNT(DISTINCT "siteId") AS sites,
             SUM(COALESCE("durationMs", EXTRACT(EPOCH FROM ("lastEventAt" - "startedAt")) * 1000))::float8 AS ms
      FROM "SessionRecording" WHERE "tenantId" = ${tenant} AND "startedAt" >= ${since}`,
    db.$queryRaw<{ bytes: bigint | null }[]>`
      SELECT SUM("bytes")::bigint AS bytes FROM "SessionRecording" WHERE "tenantId" = ${tenant} AND "purgePendingAt" IS NULL`,
    db.sessionRecording.count({ where: { durationMs: { lt: 1000 } } }),
    db.$queryRaw<{ t: string; n: bigint }[]>`
      SELECT CASE WHEN "format" = 'SQL' THEN 'sql'
                  WHEN "format" = 'TERM' THEN 'ssh'
                  WHEN "format" = 'RDP' THEN 'rdp'
                  WHEN "format" <> 'GUAC' THEN 'web'
                  WHEN LOWER(COALESCE("protocol", '')) IN ('ssh', 'telnet') THEN 'ssh'
                  ELSE 'rdp' END AS t, COUNT(*) AS n
      FROM "SessionRecording" WHERE "tenantId" = ${tenant} GROUP BY 1`,
  ]);
  const byType = { all: 0, web: 0, rdp: 0, ssh: 0, sql: 0 };
  for (const r of types) {
    const n = Number(r.n);
    byType.all += n;
    if (r.t === "web" || r.t === "rdp" || r.t === "ssh" || r.t === "sql") byType[r.t] += n;
  }
  return {
    week: Number(week[0]?.n ?? 0),
    weekSites: Number(week[0]?.sites ?? 0),
    weekMs: Math.round(week[0]?.ms ?? 0),
    bytes: Number(kept[0]?.bytes ?? 0),
    empty,
    byType,
  };
}
