import { withTenant } from "@/lib/tenant/scope";
import { multiTenantEnabled } from "@/lib/tenant/enabled";
import { listActiveTenantIds } from "@/lib/tenant/internal";

// Fans a cron job out across every ACTIVE tenant in cloud mode, scoping each
// invocation with withTenant (RLS + insert-trigger, same as a request). Self
// -host (flag off): runs the job exactly once, under the implicit default
// scope — byte-identical to the pre-multi-tenant behavior.
export async function forEachTenant<T>(job: () => Promise<T>): Promise<T[]> {
  if (!multiTenantEnabled()) return [await job()];
  const ids = await listActiveTenantIds();
  const out: T[] = [];
  for (const t of ids) out.push(await withTenant(t, job));
  return out;
}

/**
 * Like forEachTenant, but hands the job its tenant id and opens NO scope.
 *
 * For a job that must do SLOW work between its reads and its writes -- a network
 * probe, a webhook, a mail send. withTenant establishes the tenant by opening a
 * transaction and holding it open for the whole callback, and Prisma's
 * interactive-transaction timeout is 5 s, so such a job loses its own results the
 * moment the network is slower than that: measured on site-health, 6252 ms, and
 * the health of every site in that pass went unwritten with a P2028. The callback
 * wraps only its DB phases, via `inTenant`.
 *
 * Self-host (flag off) passes null and the job runs unscoped exactly once --
 * identical to forEachTenant there.
 */
export async function forEachTenantId<T>(job: (tenantId: string | null) => Promise<T>): Promise<T[]> {
  if (!multiTenantEnabled()) return [await job(null)];
  const ids = await listActiveTenantIds();
  const out: T[] = [];
  for (const t of ids) out.push(await job(t));
  return out;
}

/** Runs fn inside one tenant's scope, or unscoped when tenantId is null (self-host). */
export function inTenant<T>(tenantId: string | null, fn: () => Promise<T>): Promise<T> {
  return tenantId === null ? fn() : withTenant(tenantId, fn);
}
