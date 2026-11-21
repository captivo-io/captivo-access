import { db } from "@/lib/db";
import { inTenant } from "@/lib/cron/for-each-tenant";
import { currentTenantId, outsideScope } from "@/lib/tenant/context";
import { multiTenantEnabled } from "@/lib/tenant/enabled";
import type { AdminActor } from "@/lib/audit/admin";
import { AFTER_SESSION_DELAY_MS, planRotations, runJob, saveResult, type RotationSkip } from "@/lib/vault/rotation";

// Running rotation (lib/vault/rotation.ts) for one tenant: from the site-health
// cron, a minute after a session ends, and on "Rotate now". One pass per
// tenant at a time; a kick that arrives during a pass runs another after it.

const running = new Map<string, boolean>(); // tenant → another pass was asked for

export async function runRotationPass(tenantId: string | null, opts: { siteId?: string; force?: boolean; actor?: AdminActor | null } = {}): Promise<{ rotated: number; skipped: RotationSkip[] }> {
  // "Rotate now" for one resource runs at once, beside a pass.
  if (opts.siteId) return pass(tenantId, opts);
  const key = tenantId ?? "";
  if (running.has(key)) {
    running.set(key, true);
    return { rotated: 0, skipped: [] };
  }
  running.set(key, false);
  try {
    return await pass(tenantId, opts);
  } finally {
    const again = running.get(key);
    running.delete(key);
    if (again) void runRotationPass(tenantId).catch((e) => console.error("vault: rotation pass failed", e));
  }
}

async function pass(tenantId: string | null, opts: { siteId?: string; force?: boolean; actor?: AdminActor | null }) {
  const scoped = <T>(fn: () => Promise<T>) => inTenant(tenantId, fn);
  let rotated = 0;
  const { jobs, skipped } = await scoped(() => planRotations(new Date(), { siteId: opts.siteId, force: opts.force }));
  for (const j of jobs) {
    const r = await runJob(j, scoped).catch((e) => ({ kind: "failed" as const, detail: e instanceof Error ? e.message : "Rotation failed.", outOfSync: false, keepPending: true }));
    await scoped(() => saveResult(j, r, opts.actor ?? null));
    if (r.kind === "rotated") rotated++;
    // Changed outside Captivo, and there is an account to reset it: now, not next pass.
    if (r.kind === "mismatch" && j.reconcile) rotated += (await pass(tenantId, { siteId: j.siteId, force: true, actor: opts.actor })).rotated;
  }
  return { rotated, skipped };
}

/** Runs a pass for the current tenant after delayMs, outside the caller's scope. */
export function kickRotation(delayMs: number, opts: { siteId?: string; force?: boolean; actor?: AdminActor | null } = {}): void {
  if (process.env.NODE_ENV === "test") return;
  const tenantId = multiTenantEnabled() ? currentTenantId() : null;
  outsideScope(() => {
    const t = setTimeout(() => {
      runRotationPass(tenantId, opts).catch((e) => console.error("vault: rotation pass failed", e));
    }, delayMs);
    t.unref?.();
  });
}

/**
 * Sessions on these resources ended (the audit ingest saw session_close):
 * resources that rotate after a session are due a minute from now. A session
 * still open then holds it until that one ends too.
 */
export async function noteSessionsClosed(siteIds: string[], now = new Date()): Promise<number> {
  const ids = [...new Set(siteIds.filter(Boolean))];
  if (ids.length === 0) return 0;
  const at = new Date(now.getTime() + AFTER_SESSION_DELAY_MS);
  const res = await db.vaultCredential.updateMany({
    where: { siteId: { in: ids }, rotateAfterSession: true, sealedTo: { not: null }, OR: [{ rotateDueAt: null }, { rotateDueAt: { gt: at } }] },
    data: { rotateDueAt: at },
  });
  if (res.count > 0) kickRotation(AFTER_SESSION_DELAY_MS + 5_000);
  return res.count;
}
