import { db } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { currentTenantId } from "@/lib/tenant/context";
import { AUDIT_CHAIN_LOCK_KEY } from "@/lib/audit/chain";
import { ADMIN_AUDIT_CHAIN_LOCK_KEY } from "@/lib/audit/admin-chain";

// The two tamper-evidence chains. Each tenant has one head row per scope in
// AuditChainState (was the fixed ids "singleton" / "admin-singleton").
export type ChainScope = "access" | "admin";

// Composite unique key for a tenant's chain head of the given scope.
export function chainKey(scope: ChainScope) {
  return { tenantId_scope: { tenantId: currentTenantId(), scope } };
}

// Serializes appends to the CURRENT tenant's chain of this scope until the
// transaction ends. The lock is per tenant, like the head it guards: one global
// lock let an append that holds it (a platform action in the request's own
// transaction) block a nested append to another tenant's chain, and the two
// waited on each other until both transactions expired.
export async function lockChain(tx: Prisma.TransactionClient, scope: ChainScope): Promise<void> {
  const seed = scope === "admin" ? ADMIN_AUDIT_CHAIN_LOCK_KEY : AUDIT_CHAIN_LOCK_KEY;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${scope}:${currentTenantId()}`}, ${seed}))`;
}

/** Remember a console verification on the chain head (no head yet: nothing to remember). */
export async function recordVerification(scope: ChainScope, ok: boolean, at: Date = new Date()): Promise<void> {
  await db.auditChainState.updateMany({ where: { tenantId: currentTenantId(), scope }, data: { verifiedAt: at, verifiedOk: ok } });
}
