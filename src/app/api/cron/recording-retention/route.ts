import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqualStr } from "@/lib/secure-compare";
import { db } from "@/lib/db";
import { resolvedRecordingRetentionDays } from "@/lib/settings/platform";
import { appendAuditEvents } from "@/lib/audit/append";
import { recordCronRun } from "@/lib/cron/heartbeat";
import { forEachTenant } from "@/lib/cron/for-each-tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function cronAuthorized(req: NextRequest): boolean {
  const s = process.env.CRON_SECRET;
  return !!s && timingSafeEqualStr(req.headers.get("authorization"), `Bearer ${s}`);
}

// Deletes session recordings older than the configured retention window
// (Policy → Recording retention). RecordingChunk rows cascade on the parent
// delete. Disabled (no-op) when retention is 0/unset. Fails closed without a
// valid CRON_SECRET. Intended to run daily.
export async function POST(req: NextRequest) {
  if (!cronAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  // The retention window, the deleteMany, and the audit append all run inside
  // each tenant's own scope (fanned out via forEachTenant) — a tenant's
  // recordings are only ever deleted/appended against its own rows.
  const results = await forEachTenant(async () => {
    // Stamped INSIDE the tenant scope, deliberately. CronRun is a per-tenant table
    // behind RLS, so an upsert from outside a scope is rejected by the row policy
    // and swallowed by the best-effort catch: the heartbeat simply never landed in
    // cloud mode. Since cronHealth() treats site-health as the scheduler's pulse,
    // every tenant's console showed "Background jobs haven't run yet." while the
    // jobs were in fact running -- and the real stale-job warning could never fire,
    // because that branch is only reached once the pulse is healthy.
    await recordCronRun("recording-retention");
    const days = await resolvedRecordingRetentionDays();
    if (days <= 0) return { deleted: 0, note: "retention_disabled" as const };

    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const result = await db.sessionRecording.deleteMany({ where: { startedAt: { lt: cutoff } } });

    if (result.count > 0) {
      // Record the automated deletion in the tamper-evident chain (system actor:
      // no userId/siteId). Best-effort — the deletion is the primary action.
      // appendAuditEvents keys the event to currentTenantId(), which is this
      // job's tenant.
      try {
        await appendAuditEvents([
          {
            host: "manager",
            method: "DELETE",
            path: "/api/cron/recording-retention",
            status: 200,
            decision: "ALLOW",
            reason: `Recording retention: deleted ${result.count} session recording(s) older than ${days} days`,
          },
        ]);
      } catch (err) {
        console.error("[recording-retention] audit append failed:", err);
      }
    }

    return { deleted: result.count };
  });

  // Self-host (exactly one, implicit-default result): the historical top-level
  // { deleted } / { deleted, note } shape, unchanged. Multi-tenant fan-out: a
  // per-tenant breakdown.
  return NextResponse.json(results.length === 1 ? results[0] : { results });
}
