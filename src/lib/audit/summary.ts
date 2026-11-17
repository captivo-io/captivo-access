import { db } from "@/lib/db";
import { TRANSFER_VERBS } from "./access-format";

export interface AuditSummary {
  requests: number;
  denied: number;
  transfers: number;
  people: number;
}

/** The last day of proxied requests, for the summary strip (timestamp is indexed). */
export async function auditSummary(now: Date = new Date()): Promise<AuditSummary> {
  const since = { gte: new Date(now.getTime() - 24 * 3600_000) };
  const [requests, denied, transfers, people] = await Promise.all([
    db.auditEvent.count({ where: { timestamp: since } }),
    db.auditEvent.count({ where: { timestamp: since, decision: "DENY" } }),
    db.auditEvent.count({ where: { timestamp: since, method: { in: [...TRANSFER_VERBS] } } }),
    db.auditEvent.groupBy({ by: ["userId"], where: { timestamp: since, userId: { not: null } } }),
  ]);
  return { requests, denied, transfers, people: people.length };
}
