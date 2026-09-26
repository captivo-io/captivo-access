import { db } from "@/lib/db";
import { currentTenantId } from "@/lib/tenant/context";

/**
 * Erasure of a recording whose bytes are not ours to delete.
 *
 * The content lives on the customer's connector, so an administrator's deletion is a
 * REQUEST, not an act: the row is marked pending, the connector is asked on its next
 * policy push, and the row is removed only once the connector confirms.
 *
 * The consequence is real and must be surfaced, never smoothed over: while a
 * connector is offline, an accepted erasure has not happened. Reporting it as done
 * would be a false compliance claim.
 */

/** Mark a recording for erasure. Returns false when it does not exist. */
export async function requestErasure(id: string): Promise<boolean> {
  const rec = await db.sessionRecording.findUnique({ where: { id }, select: { id: true } });
  if (!rec) return false;
  await db.sessionRecording.update({
    where: { id },
    data: { purgePendingAt: new Date() },
  });
  return true;
}

/** Recording keys this tenant still owes the connectors, grouped per connector. */
export async function pendingErasuresByConnector(): Promise<Map<string, string[]>> {
  const pending = await db.sessionRecording.findMany({
    where: { purgePendingAt: { not: null } },
    select: { recordingKey: true, siteId: true },
  });
  if (pending.length === 0) return new Map();

  const sites = await db.site.findMany({
    where: { id: { in: [...new Set(pending.map((p) => p.siteId))] } },
    select: { id: true, connectorId: true },
  });
  const connectorBySite = new Map(sites.map((s) => [s.id, s.connectorId]));

  const out = new Map<string, string[]>();
  for (const p of pending) {
    const connectorId = connectorBySite.get(p.siteId);
    // A recording whose site or connector is gone can never be confirmed erased.
    // It stays pending on purpose: silently dropping it would report an erasure
    // that no one performed.
    if (!connectorId) continue;
    const list = out.get(connectorId) ?? [];
    list.push(p.recordingKey);
    out.set(connectorId, list);
  }
  return out;
}

/**
 * Apply a connector's confirmation: the bytes are gone, so the index row goes too.
 * Only rows that were actually pending are removed -- a confirmation for something
 * nobody asked to erase must not delete an administrator's recording.
 */
export async function confirmErasures(recordingKeys: string[]): Promise<number> {
  if (recordingKeys.length === 0) return 0;
  const res = await db.sessionRecording.deleteMany({
    where: {
      tenantId: currentTenantId(),
      recordingKey: { in: recordingKeys },
      purgePendingAt: { not: null },
    },
  });
  return res.count;
}

/**
 * Apply a retention sweep report: the connector removed N recordings older than the
 * window, so drop index rows whose bytes can no longer exist. Age is measured on the
 * index's own lastEventAt, which is what the connector's directory mtime tracks.
 */
export async function trimIndexAfterRetention(retentionDays: number): Promise<number> {
  if (retentionDays <= 0) return 0;
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  const res = await db.sessionRecording.deleteMany({
    where: { tenantId: currentTenantId(), lastEventAt: { lt: cutoff } },
  });
  return res.count;
}
