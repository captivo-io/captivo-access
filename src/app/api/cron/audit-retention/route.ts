import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqualStr } from "@/lib/secure-compare";
import { db } from "@/lib/db";
import { resolvedAuditRetentionDays } from "@/lib/settings/platform";
import { recordCronRun } from "@/lib/cron/heartbeat";
import { forEachTenant } from "@/lib/cron/for-each-tenant";

function cronAuthorized(req: NextRequest): boolean {
  const s = process.env.CRON_SECRET;
  return !!s && timingSafeEqualStr(req.headers.get("authorization"), `Bearer ${s}`);
}

export async function POST(req: NextRequest) {
  if (!cronAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  // CRITICAL: seq is per-tenant-chain (AuditEvent is unique on [tenantId, seq]),
  // so both the cutoffSeq lookup AND the deleteMany must run INSIDE each
  // tenant's own scope (fanned out via forEachTenant). A cutoffSeq computed
  // globally (or a deleteMany not scoped to the same tenant) would delete
  // across chains by an unrelated seq number and punch a hole the
  // tamper-evidence verifier reads as tampering.
  const results = await forEachTenant(async () => {
    // Stamped INSIDE the tenant scope, deliberately. CronRun is a per-tenant table
    // behind RLS, so an upsert from outside a scope is rejected by the row policy
    // and swallowed by the best-effort catch: the heartbeat simply never landed in
    // cloud mode. Since cronHealth() treats site-health as the scheduler's pulse,
    // every tenant's console showed "Background jobs haven't run yet." while the
    // jobs were in fact running -- and the real stale-job warning could never fire,
    // because that branch is only reached once the pulse is healthy.
    await recordCronRun("audit-retention");
    // Retention days come from PlatformSettings (UI), falling back to the
    // AUDIT_RETENTION_DAYS env then 730. resolvedAuditRetentionDays already
    // guards against the empty/NaN footgun (which would purge everything).
    const retentionDays = await resolvedAuditRetentionDays();
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
    // Delete a seq-contiguous PREFIX, not a raw timestamp slice: seq (ingest
    // order) and timestamp (event time) can diverge for delayed batches, and
    // deleting an interior seq would punch a hole the tamper-evidence
    // verifier reads as tampering.
    const boundary = await db.auditEvent.aggregate({
      where: { timestamp: { lt: cutoff } },
      _max: { seq: true },
    });
    const cutoffSeq = boundary._max.seq;
    const result = cutoffSeq === null
      ? { count: 0 }
      : await db.auditEvent.deleteMany({ where: { seq: { lte: cutoffSeq } } });
    return { deleted: result.count };
  });

  // Self-host (exactly one, implicit-default result): the historical top-level
  // { deleted } shape, unchanged. Multi-tenant fan-out: a per-tenant breakdown.
  return NextResponse.json(results.length === 1 ? results[0] : { results });
}
