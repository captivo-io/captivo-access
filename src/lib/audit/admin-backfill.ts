import { db } from "@/lib/db";
import { computeAdminHash } from "./admin-chain";
import { chainKey, lockChain } from "@/lib/audit/chain-key";
import { currentTenantId } from "@/lib/tenant/context";

// One-time, idempotent: chains every AdminAuditEvent row that has no seq yet,
// in insertion order, continuing from the current admin head. No-op if none.
export async function backfillAdminChain(): Promise<{ backfilled: number }> {
  return db.$transaction(async (tx) => {
    await lockChain(tx, "admin");
    const pending = await tx.adminAuditEvent.findMany({
      where: { seq: null },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true, timestamp: true, actorId: true, actorEmail: true, action: true, targetType: true, targetId: true, summary: true, metadata: true, clientIp: true },
    });
    if (pending.length === 0) return { backfilled: 0 };
    const head = await tx.auditChainState.upsert({
      where: chainKey("admin"), create: { tenantId: currentTenantId(), scope: "admin" }, update: {},
      select: { lastSeq: true, lastHash: true },
    });
    let lastSeq = head.lastSeq;
    let lastHash = head.lastHash;
    for (const r of pending) {
      const seq = lastSeq + 1n;
      const hash = computeAdminHash(lastHash, {
        seq, timestamp: r.timestamp, actorId: r.actorId, actorEmail: r.actorEmail,
        action: r.action, targetType: r.targetType, targetId: r.targetId, summary: r.summary,
        metadata: r.metadata ?? null, clientIp: r.clientIp,
      });
      await tx.adminAuditEvent.update({ where: { id: r.id }, data: { seq, prevHash: lastHash, hash } });
      lastSeq = seq;
      lastHash = hash;
    }
    await tx.auditChainState.update({ where: chainKey("admin"), data: { lastSeq, lastHash } });
    return { backfilled: pending.length };
  });
}
