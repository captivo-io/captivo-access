import { currentTenantId } from "@/lib/tenant/context";
import { searchRecordingsOnConnectors } from "@/lib/recording/remote-search";
import { db } from "@/lib/db";
import { buildRecordingWhere, type RecordingFilter } from "./filter";

const RECORDING_SELECT = {
  id: true,
  siteId: true,
  userId: true,
  host: true,
  startedAt: true,
  lastEventAt: true,
  eventCount: true,
  bytes: true,
  format: true,
  protocol: true,
} as const;

export interface RecordingRow {
  id: string;
  siteId: string;
  userId: string;
  host: string;
  startedAt: Date;
  lastEventAt: Date;
  eventCount: number;
  bytes: number;
  format: string;
  protocol: string | null;
}

export async function listRecordings(
  filter: RecordingFilter,
): Promise<{
  rows: RecordingRow[];
  total: number;
  tooBroad?: boolean;
  /** At least one connector could not be searched: the answer is incomplete. */
  partial?: boolean;
  unreachableConnectors?: string[];
}> {
  const baseWhere = buildRecordingWhere(filter);
  const cmd = filter.cmd?.trim();

  if (cmd && cmd.length >= 2) {
    // Phase 1: candidate recordings under the other filters, with the connector
    // that holds each one's bytes. keystrokeLogging is opt-in, so most recordings
    // have no keystroke chunks and the connector skips them cheaply.
    const candidates = await db.sessionRecording.findMany({
      where: baseWhere,
      select: { recordingKey: true, siteId: true },
    });
    if (candidates.length === 0) return { rows: [], total: 0 };

    // SessionRecording has no site relation, only siteId, so resolve the owning
    // connectors in one query rather than per recording.
    const sites = await db.site.findMany({
      where: { id: { in: [...new Set(candidates.map((c) => c.siteId))] } },
      select: { id: true, connectorId: true },
    });
    const connectorBySite = new Map(sites.map((s) => [s.id, s.connectorId]));

    // Phase 2: ask each connector to search its OWN store. The keystroke text
    // lives on the customer's host, so the control plane cannot scan it -- and
    // must not pretend a partial answer is a negative one.
    const fan = await searchRecordingsOnConnectors({
      tenantId: currentTenantId(),
      query: cmd,
      candidates: candidates.map((c) => ({
        recordingKey: c.recordingKey,
        connectorId: connectorBySite.get(c.siteId) ?? null,
      })),
    });
    // A connector that hit its decrypt budget is the same "narrow your filters"
    // signal the central scan used to raise from COMMAND_SCAN_CAP.
    if (fan.truncated && fan.matchedKeys.length === 0) return { rows: [], total: 0, tooBroad: true };
    const matchedKeys = new Set(fan.matchedKeys);
    if (matchedKeys.size === 0) {
      return { rows: [], total: 0, partial: fan.partial, unreachableConnectors: fan.unreachableConnectors };
    }

    // Phase 4: list the matching recordings, still honouring the other filters.
    const where = { ...baseWhere, recordingKey: { in: [...matchedKeys] } };
    const [rows, total] = await Promise.all([
      db.sessionRecording.findMany({
        where,
        orderBy: { startedAt: "desc" },
        skip: filter.offset,
        take: filter.limit,
        select: RECORDING_SELECT,
      }),
      db.sessionRecording.count({ where }),
    ]);
    return { rows, total };
  }

  const where = baseWhere;
  const [rows, total] = await Promise.all([
    db.sessionRecording.findMany({
      where,
      orderBy: { startedAt: "desc" },
      skip: filter.offset,
      take: filter.limit,
      select: RECORDING_SELECT,
    }),
    db.sessionRecording.count({ where }),
  ]);
  return { rows, total };
}
