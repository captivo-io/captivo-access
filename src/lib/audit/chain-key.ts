import { db } from "@/lib/db";
import { currentTenantId } from "@/lib/tenant/context";

// The two tamper-evidence chains. Each tenant has one head row per scope in
// AuditChainState (was the fixed ids "singleton" / "admin-singleton").
export type ChainScope = "access" | "admin";

// Composite unique key for a tenant's chain head of the given scope.
export function chainKey(scope: ChainScope) {
  return { tenantId_scope: { tenantId: currentTenantId(), scope } };
}

/** Remember a console verification on the chain head (no head yet: nothing to remember). */
export async function recordVerification(scope: ChainScope, ok: boolean, at: Date = new Date()): Promise<void> {
  await db.auditChainState.updateMany({ where: { tenantId: currentTenantId(), scope }, data: { verifiedAt: at, verifiedOk: ok } });
}
