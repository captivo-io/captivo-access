import { db } from "@/lib/db";

/**
 * Copies of a recording on the other members of a connector group.
 *
 * A group with `replicateSince` set keeps a copy, on each of its other members,
 * of every recording whose session started after that moment. The data plane
 * does the copying (dataplane/recreplicate.go); it asks here what a connector
 * still owes and reports where each copy stands. This module is the control
 * plane's half: it decides who owes what, and keeps the index.
 *
 * The bytes never come here. A row says "this connector holds a copy of this
 * recording, this far along".
 */

/** The most a connector is told it owes in one answer. */
const WORK_MAX = 50;
/** The most new copies registered for a connector in one pass. */
const REGISTER_MAX = 200;

export type ReplicaWork = { tenantId: string; recordingKey: string; originConnectorId: string };

/**
 * Registers the copies a connector now owes, and answers what it still has to
 * copy. A recording is owed when it was carried by another member of a group
 * that has replication on, started after the group turned it on, and is not
 * being erased. A copy that is complete is owed again only if the recording
 * has grown since (a session that paused for a long while and went on).
 */
export async function replicaWorkFor(connectorId: string, tenantId: string): Promise<ReplicaWork[]> {
  const memberships = await db.connectorGroupMember.findMany({
    where: { connectorId, group: { replicateSince: { not: null } } },
    select: { group: { select: { replicateSince: true, members: { select: { connectorId: true } } } } },
  });
  if (memberships.length === 0) return [];

  for (const { group } of memberships) {
    const since = group.replicateSince;
    if (!since) continue;
    const origins = group.members.map((m) => m.connectorId).filter((id) => id !== connectorId);
    if (origins.length === 0) continue;
    const fresh = await db.sessionRecording.findMany({
      where: { connectorId: { in: origins }, startedAt: { gte: since }, purgePendingAt: null, replicas: { none: { connectorId } } },
      orderBy: { startedAt: "asc" },
      take: REGISTER_MAX,
      select: { id: true },
    });
    if (fresh.length > 0) {
      await db.recordingReplica.createMany({
        data: fresh.map((r) => ({ recordingId: r.id, connectorId, tenantId })),
        skipDuplicates: true,
      });
    }
  }

  const rows = await db.recordingReplica.findMany({
    where: { connectorId, recording: { purgePendingAt: null, connectorId: { not: null } } },
    orderBy: { createdAt: "asc" },
    select: { state: true, completedAt: true, recording: { select: { recordingKey: true, connectorId: true, lastEventAt: true } } },
  });
  return rows
    .filter((r) => r.state !== "COMPLETE" || !r.completedAt || r.recording.lastEventAt > r.completedAt)
    .slice(0, WORK_MAX)
    .map((r) => ({ tenantId, recordingKey: r.recording.recordingKey, originConnectorId: r.recording.connectorId as string }));
}

export type ReplicaReport = { recordingKey: string; state: "COPYING" | "COMPLETE"; bytes: number; error: string };

/** Reads a data plane report body; anything malformed is dropped. */
export function parseReplicaReports(raw: unknown): ReplicaReport[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 200).flatMap((x) => {
    const o = (x ?? {}) as Record<string, unknown>;
    if (typeof o.recordingKey !== "string" || !o.recordingKey) return [];
    if (o.state !== "COPYING" && o.state !== "COMPLETE") return [];
    const bytes = typeof o.bytes === "number" && Number.isFinite(o.bytes) && o.bytes > 0 ? Math.min(Math.floor(o.bytes), 2 ** 31 - 1) : 0;
    // A short code, never free text.
    const error = typeof o.error === "string" && /^[a-z_]{1,40}$/.test(o.error) ? o.error : "";
    return [{ recordingKey: o.recordingKey, state: o.state, bytes, error }];
  });
}

/** Records where a connector's copies stand. Returns how many rows changed. */
export async function applyReplicaReports(connectorId: string, tenantId: string, reports: ReplicaReport[]): Promise<number> {
  let changed = 0;
  for (const r of reports) {
    const rec = await db.sessionRecording.findUnique({
      where: { tenantId_recordingKey: { tenantId, recordingKey: r.recordingKey } },
      select: { id: true },
    });
    if (!rec) continue;
    const res = await db.recordingReplica.updateMany({
      where: { recordingId: rec.id, connectorId },
      data: {
        state: r.state,
        bytes: r.bytes,
        lastError: r.error || null,
        completedAt: r.state === "COMPLETE" ? new Date() : null,
      },
    });
    changed += res.count;
  }
  return changed;
}
