import { base } from "@/lib/db";
import { withScope } from "@/lib/tenant/context";
import { multiTenantEnabled } from "@/lib/tenant/enabled";

// Establishes the tenant scope for `fn` (and everything it awaits).
//
// Multi-tenant (cloud): opens a request transaction, sets the transaction-local
// tenant GUC on its connection, and stores the tx in ALS so `db` routes every
// query onto it — Postgres RLS scopes reads and a BEFORE INSERT trigger stamps
// tenantId on writes, both from the same GUC. Leak-proof: the GUC is
// transaction-local, so a pooled connection never carries it across requests.
//
// Single-tenant (self-host, flag off): a plain ALS tenant scope, no transaction —
// the owner role bypasses RLS and behavior is unchanged.
//
// Lives in its own module (not context.ts) so context.ts stays db-free and the
// import graph is acyclic: context ← db ← scope.
/**
 * How long a tenant scope may stay open.
 *
 * This is a DATABASE TRANSACTION budget, not a request timeout, and that is the
 * trap: everything the callback awaits is inside it. Prisma's own default is
 * 5000 ms and it used to apply invisibly -- which meant any handler that waited
 * on someone else's machine died at five seconds with a P2028 naming a Prisma
 * model, nowhere near the call that hung. The value is now a decision.
 */
export const DEFAULT_SCOPE_BUDGET_MS = 5_000;

/**
 * For an entry point that legitimately waits on a THIRD PARTY -- a connector on a
 * customer's network, their directory server, their mail relay, their identity
 * provider, a file transfer.
 *
 * Must stay comfortably above the longest ceiling anything downstream applies, or
 * this budget silently overrides that one: the LDAP probe allows itself 12 s
 * (dataplane/ldap.go), and under the 5 s default a directory controller that
 * answered in 6.6 s -- measured on a real customer's DC -- failed every time
 * inside a probe that would have succeeded.
 *
 * Opt in per entry point rather than raising the default: an open transaction
 * holds a pooled connection, so a scope this long is a cost to pay deliberately
 * where it buys something, not everywhere.
 */
export const SLOW_SCOPE_BUDGET_MS = 30_000;

export type TenantScopeOptions = {
  /** Transaction budget in ms. Defaults to DEFAULT_SCOPE_BUDGET_MS. */
  budgetMs?: number;
};

/**
 * Above this, a scope is worth a line in the log.
 *
 * Not an error -- a slow admin action is allowed to be slow. It is the number that
 * decides a question this design defers: a scope holds one pooled connection for
 * its whole life, so if long scopes become frequent or concurrent, the tenant GUC
 * has to stop living in a long transaction (set per query instead). That change
 * replaces an isolation boundary that is leak-proof BY CONSTRUCTION -- a
 * transaction-local GUC cannot ride a pooled connection into another request --
 * with one that has to be proven not to leak, so it should be made when the
 * measurements demand it and not before.
 *
 * Measured 2026-09-27: pool of 25 (12 CPUs), one active connection, longest
 * transaction under a second. This log is how we would notice that changing.
 */
const LONG_SCOPE_LOG_MS = 5_000;

export function withTenant<T>(
  tenantId: string,
  fn: () => Promise<T>,
  opts?: TenantScopeOptions,
): Promise<T> {
  if (!multiTenantEnabled()) return withScope({ tenantId }, fn);
  const startedAt = Date.now();
  return base
    .$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_tenant', ${tenantId}, true)`;
        return withScope({ tenantId, tx }, fn);
      },
      { timeout: opts?.budgetMs ?? DEFAULT_SCOPE_BUDGET_MS },
    )
    .finally(() => {
      const heldMs = Date.now() - startedAt;
      if (heldMs >= LONG_SCOPE_LOG_MS) {
        // finally, not then: a scope that EXPIRED is the most interesting one to
        // see, and logging only on success would hide exactly those.
        console.warn(`tenant scope held a connection for ${heldMs}ms (budget ${opts?.budgetMs ?? DEFAULT_SCOPE_BUDGET_MS}ms)`);
      }
    });
}
