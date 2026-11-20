import { db } from "@/lib/db";

/**
 * Where a new destination starts: after everything already written, or, with
 * `since`, at the first record from that time on. Runs in the tenant's scope.
 */
export async function startCursors(since: Date | null): Promise<{ accessCursor: bigint; adminCursor: bigint }> {
  const [accessMax, adminMax] = await Promise.all([
    db.auditEvent.aggregate({ _max: { seq: true } }),
    db.adminAuditEvent.aggregate({ _max: { seq: true } }),
  ]);
  let accessCursor = accessMax._max.seq ?? BigInt(0);
  let adminCursor = adminMax._max.seq ?? BigInt(0);
  if (since) {
    const [a, b] = await Promise.all([
      db.auditEvent.findFirst({ where: { timestamp: { gte: since } }, orderBy: { seq: "asc" }, select: { seq: true } }),
      db.adminAuditEvent.findFirst({ where: { timestamp: { gte: since }, seq: { not: null } }, orderBy: { seq: "asc" }, select: { seq: true } }),
    ]);
    if (a) accessCursor = a.seq - BigInt(1);
    if (b?.seq) adminCursor = b.seq - BigInt(1);
  }
  return { accessCursor, adminCursor };
}
