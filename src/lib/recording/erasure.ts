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
 *
 * A recording with copies on other members of its connector group is held by
 * several connectors, and the erasure is complete only when EVERY holder has
 * confirmed: the original (`originPurgedAt`) and each copy (`RecordingReplica.purgedAt`).
 * The row goes with the last confirmation.
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
    select: { recordingKey: true, siteId: true, connectorId: true, originPurgedAt: true, replicas: { select: { connectorId: true, purgedAt: true } } },
  });
  if (pending.length === 0) return new Map();

  const sites = await db.site.findMany({
    where: { id: { in: [...new Set(pending.map((p) => p.siteId))] } },
    select: { id: true, connectorId: true },
  });
  const connectorBySite = new Map(sites.map((s) => [s.id, s.connectorId]));

  const out = new Map<string, string[]>();
  const owe = (connectorId: string, key: string) => {
    const list = out.get(connectorId) ?? [];
    if (!list.includes(key)) list.push(key);
    out.set(connectorId, list);
  };
  for (const p of pending) {
    // A connector group's recording is on the member that carried it.
    const connectorId = p.connectorId ?? connectorBySite.get(p.siteId);
    // A recording whose site or connector is gone can never be confirmed erased.
    // It stays pending on purpose: silently dropping it would report an erasure
    // that no one performed.
    if (connectorId && !p.originPurgedAt) owe(connectorId, p.recordingKey);
    // Every member holding a copy owes the erasure too.
    for (const r of p.replicas ?? []) if (!r.purgedAt) owe(r.connectorId, p.recordingKey);
  }
  return out;
}

/**
 * Apply a connector's confirmation: the bytes are gone from THAT connector. With
 * its `connectorId` the confirmation is recorded against the holder (the original
 * or a copy) and the index row goes when the last holder has confirmed. Without
 * one -- how a confirmation arrived before copies existed -- it deletes the row.
 * Only rows that were actually pending are touched: a confirmation for something
 * nobody asked to erase must not delete an administrator's recording.
 */
export async function confirmErasures(recordingKeys: string[], connectorId?: string): Promise<number> {
  if (recordingKeys.length === 0) return 0;
  if (connectorId) return confirmHolder(recordingKeys, connectorId);
  const res = await db.sessionRecording.deleteMany({
    where: {
      tenantId: currentTenantId(),
      recordingKey: { in: recordingKeys },
      purgePendingAt: { not: null },
    },
  });
  return res.count;
}

async function confirmHolder(recordingKeys: string[], connectorId: string): Promise<number> {
  const tenantId = currentTenantId();
  const pending = await db.sessionRecording.findMany({
    where: { tenantId, recordingKey: { in: recordingKeys }, purgePendingAt: { not: null } },
    select: { id: true, siteId: true, connectorId: true, originPurgedAt: true, replicas: { select: { connectorId: true, purgedAt: true } } },
  });
  if (pending.length === 0) return 0;
  const sites = await db.site.findMany({
    where: { id: { in: [...new Set(pending.filter((p) => !p.connectorId).map((p) => p.siteId))] } },
    select: { id: true, connectorId: true },
  });
  const connectorBySite = new Map(sites.map((s) => [s.id, s.connectorId]));
  const now = new Date();
  let deleted = 0;
  for (const rec of pending) {
    const origin = rec.connectorId ?? connectorBySite.get(rec.siteId) ?? null;
    let originDone = rec.originPurgedAt !== null;
    if (origin === connectorId && !originDone) {
      await db.sessionRecording.update({ where: { id: rec.id }, data: { originPurgedAt: now } });
      originDone = true;
    }
    await db.recordingReplica.updateMany({ where: { recordingId: rec.id, connectorId, purgedAt: null }, data: { purgedAt: now } });
    const stillOwed = rec.replicas.some((r) => r.connectorId !== connectorId && r.purgedAt === null);
    if (originDone && !stillOwed) {
      const res = await db.sessionRecording.deleteMany({ where: { id: rec.id, purgePendingAt: { not: null } } });
      deleted += res.count;
    }
  }
  return deleted;
}

/**
 * Who still owes an erasure of this recording, by connector id: the original and
 * the copies that have not confirmed. Empty once all have.
 */
export async function holdersOwing(recordingId: string): Promise<string[]> {
  const rec = await db.sessionRecording.findUnique({
    where: { id: recordingId },
    select: { siteId: true, connectorId: true, originPurgedAt: true, replicas: { select: { connectorId: true, purgedAt: true } } },
  });
  if (!rec) return [];
  const out: string[] = [];
  let origin = rec.connectorId;
  if (!origin) origin = (await db.site.findUnique({ where: { id: rec.siteId }, select: { connectorId: true } }))?.connectorId ?? null;
  if (origin && !rec.originPurgedAt) out.push(origin);
  for (const r of rec.replicas) if (!r.purgedAt) out.push(r.connectorId);
  return out;
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
