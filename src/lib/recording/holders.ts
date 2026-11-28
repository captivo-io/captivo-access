import { db } from "@/lib/db";
import { fetchFromConnector, type RecFetch } from "@/lib/dataplane/recordings";
import { currentTenantId } from "@/lib/tenant/context";
import { connectorForRecording } from "./connector-of";

/**
 * Who can play a recording: the connector that carried the session, then the
 * members of its group that hold a copy (src/lib/recording/replicas.ts).
 *
 * The original is asked first, always; a copy answers only when the original
 * cannot (offline, or it has not got the stream). A copy that is complete
 * comes before one still being made, and a copy still being made plays as far
 * as it got -- which the recording page says.
 */
export type Stream = "guac" | "rrweb" | "video" | "keys" | "term" | "rdp";

/**
 * Whether a copy of this state can be expected to hold the stream. A graphical
 * session (RDP, VNC) is copied as its video and keystroke timeline, never as
 * the raw screen stream; and a half-copied video does not play at all.
 */
export function copyServes(rec: { protocol: string | null }, stream: Stream, complete: boolean): boolean {
  const graphical = rec.protocol === "rdp" || rec.protocol === "vnc";
  if (graphical && (stream === "guac" || stream === "rdp")) return false;
  if (stream === "video") return complete;
  return true;
}

export type RecordingRef = { id?: string; siteId: string; connectorId?: string | null; recordingKey: string; format?: string; protocol?: string | null };

export type Fetched = { got: RecFetch; connectorId: string; copy: boolean };
export type FetchFailure = { error: "no_connector" | "connector_offline" };

/** Streams one stream of a recording from whichever holder can serve it. */
export async function fetchFromHolders(
  rec: RecordingRef,
  stream: Stream,
  range?: { fromByte?: number; toByte?: number },
): Promise<Fetched | FetchFailure> {
  const original = await connectorForRecording(rec);
  const copies = rec.id
    ? await db.recordingReplica.findMany({ where: { recordingId: rec.id }, select: { connectorId: true, state: true } })
    : [];
  const usable = copies
    .filter((c) => c.connectorId !== original && copyServes({ protocol: rec.protocol ?? null }, stream, c.state === "COMPLETE"))
    .sort((a, b) => Number(b.state === "COMPLETE") - Number(a.state === "COMPLETE"));
  if (!original && usable.length === 0) return { error: "no_connector" };

  const tenantId = currentTenantId();
  const ask = (connectorId: string) =>
    fetchFromConnector({ format: stream, connectorId, tenantId, recordingKey: rec.recordingKey, ...(range ?? {}) });

  if (original) {
    const got = await ask(original);
    if (got) return { got, connectorId: original, copy: false };
  }
  for (const c of usable) {
    const got = await ask(c.connectorId);
    if (!got) continue;
    // A connector that answers with nothing does not hold this stream (a copy still
    // being made may not have reached it): that is not a recording, it is a gap.
    if (got.totalBytes === 0) {
      await got.body.cancel().catch(() => undefined);
      continue;
    }
    return { got, connectorId: c.connectorId, copy: true };
  }
  return { error: "connector_offline" };
}

export function isFailure(r: Fetched | FetchFailure): r is FetchFailure {
  return "error" in r;
}

/** The body of a failure answer, as every recording route words it. */
export const FAILURE_DETAIL: Record<FetchFailure["error"], string> = {
  no_connector: "this recording's site has no connector, so its bytes cannot be reached",
  connector_offline: "the connector holding this recording is offline; the recording is intact but unreachable",
};
