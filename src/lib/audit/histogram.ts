import { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { currentTenantId } from "@/lib/tenant/context";
import { TRANSFER_VERBS } from "./access-format";
import type { AuditFilter } from "./query";

const MIN = 60_000;
const HOUR = 60 * MIN;

export interface HistogramPlan { start: number; widthMs: number; count: number }
export interface Histogram { start: string; widthMs: number; allow: number[]; deny: number[] }

/**
 * The bars for a time range, ending at `to`: 5-minute bars for the last hour,
 * hourly for a day, 6-hourly for a week, else about 24 even bars.
 */
export function histogramPlan(from: Date, to: Date): HistogramPlan {
  const span = Math.max(MIN, to.getTime() - from.getTime());
  const widthMs =
    span <= HOUR + MIN ? 5 * MIN
    : span <= 26 * HOUR ? HOUR
    : span <= 8 * 24 * HOUR ? 6 * HOUR
    : Math.ceil(span / 24 / MIN) * MIN;
  const count = Math.min(48, Math.ceil(span / widthMs));
  return { start: to.getTime() - count * widthMs, widthMs, count };
}

/** Row counts per bar into allow / deny series; out-of-range buckets are dropped. */
export function fillHistogram(plan: HistogramPlan, rows: { b: number; decision: string; n: bigint | number }[]): Histogram {
  const allow = new Array<number>(plan.count).fill(0);
  const deny = new Array<number>(plan.count).fill(0);
  for (const r of rows) {
    const i = Math.min(plan.count - 1, r.b);
    if (i < 0) continue;
    (r.decision === "DENY" ? deny : allow)[i] += Number(r.n);
  }
  return { start: new Date(plan.start).toISOString(), widthMs: plan.widthMs, allow, deny };
}

// The same filter buildAuditWhere applies, as SQL, for the GROUP BY below.
function conditions(filter: AuditFilter): Prisma.Sql[] {
  const c: Prisma.Sql[] = [];
  if (filter.userId) c.push(Prisma.sql`"userId" = ${filter.userId}`);
  if (filter.siteId) c.push(Prisma.sql`"siteId" = ${filter.siteId}`);
  if (filter.decision) c.push(Prisma.sql`"decision"::text = ${filter.decision}`);
  if (filter.kind === "file") c.push(Prisma.sql`"method" IN (${Prisma.join([...TRANSFER_VERBS])})`);
  const q = filter.q?.trim();
  if (q && q.length >= 2) {
    const like = `%${q.replace(/[\\%_]/g, "\\$&")}%`;
    c.push(Prisma.sql`("path" ILIKE ${like} OR "host" ILIKE ${like} OR "userEmail" ILIKE ${like} OR "userName" ILIKE ${like} OR "company" ILIKE ${like} OR "clientIp" LIKE ${like})`);
  }
  return c;
}

// "timestamp" is a UTC wall time without zone, so EXTRACT(EPOCH) is exact UTC
// milliseconds whatever the session TimeZone is.
export async function auditHistogram(filter: AuditFilter & { from: Date; to: Date }): Promise<Histogram> {
  const plan = histogramPlan(filter.from, filter.to);
  const start = new Date(plan.start);
  const where = Prisma.join(
    [Prisma.sql`"tenantId" = ${currentTenantId()}`, Prisma.sql`"timestamp" >= ${start}`, Prisma.sql`"timestamp" <= ${filter.to}`, ...conditions(filter)],
    " AND ",
  );
  const rows = await db.$queryRaw<{ b: number; decision: string; n: bigint }[]>`
    SELECT FLOOR((EXTRACT(EPOCH FROM "timestamp") * 1000 - ${plan.start}) / ${plan.widthMs})::int AS b,
           "decision"::text AS decision, COUNT(*) AS n
    FROM "AuditEvent" WHERE ${where}
    GROUP BY 1, 2`;
  return fillHistogram(plan, rows);
}
