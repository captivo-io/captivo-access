/**
 * Manager to dataplane, for recordings that live on connectors.
 *
 * The manager holds no tunnel sessions -- those live in the Go dataplane -- so
 * every connector round trip goes through here. Content never lands in the
 * control plane: search returns matched keys and snippets, fetch streams through.
 */
const BASE = () => (process.env.DATAPLANE_URL || "http://access-dataplane:3102").replace(/\/+$/, "");
const SECRET = () => process.env.DATAPLANE_SECRET || "";

export type RecSearchMatch = { recordingKey: string; seq: number; snippet: string };

export type RecSearchResult =
  | { ok: true; matches: RecSearchMatch[]; truncated: boolean }
  | { ok: false; error: string };

/** Ask one connector to search its own recording store. */
export async function searchOnConnector(input: {
  connectorId: string;
  tenantId: string;
  query: string;
  recordingKeys: string[];
  maxDecrypt: number;
}): Promise<RecSearchResult> {
  try {
    const res = await fetch(`${BASE()}/rec-search`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-dataplane-secret": SECRET() },
      body: JSON.stringify(input),
      cache: "no-store",
    });
    const body = (await res.json().catch(() => ({}))) as {
      matches?: RecSearchMatch[];
      truncated?: boolean;
      error?: string;
    };
    if (!res.ok) return { ok: false, error: body.error || `dataplane ${res.status}` };
    return { ok: true, matches: body.matches ?? [], truncated: !!body.truncated };
  } catch (e) {
    // A network failure must be reported, not swallowed into "no matches".
    return { ok: false, error: e instanceof Error ? e.message : "dataplane unreachable" };
  }
}

export type RecFetch = {
  body: ReadableStream<Uint8Array>;
  /** The recording's full plaintext length, from the connector. 0 when unknown. */
  totalBytes: number;
};

/**
 * Stream one recording's bytes from its connector. Returns null when the connector
 * cannot be reached, which callers must surface rather than render as an empty
 * recording.
 *
 * fromByte/toByte carry an HTTP Range through so a video player can scrub without
 * the control plane buffering the recording.
 */
export async function fetchFromConnector(input: {
  connectorId: string;
  tenantId: string;
  recordingKey: string;
  /**
   * Which stream of the recording to replay: "guac" | "rrweb" | "video" | "keys".
   *
   * Required, deliberately. A recording holds more than one stream -- a guac
   * session records its instruction stream and its keystrokes under one key -- so
   * a caller that does not say which one it wants cannot be served a right answer,
   * and a default here would silently hand a player the wrong stream.
   */
  format: "guac" | "rrweb" | "video" | "keys";
  fromSeq?: number;
  fromByte?: number;
  toByte?: number;
}): Promise<RecFetch | null> {
  try {
    const res = await fetch(`${BASE()}/rec-fetch`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-dataplane-secret": SECRET() },
      body: JSON.stringify({
        ...input,
        fromSeq: input.fromSeq ?? 0,
        fromByte: input.fromByte ?? 0,
        toByte: input.toByte ?? 0,
      }),
      cache: "no-store",
    });
    if (!res.ok || !res.body) return null;
    return {
      body: res.body,
      totalBytes: Number(res.headers.get("x-recording-total-bytes") ?? 0) || 0,
    };
  } catch {
    return null;
  }
}
