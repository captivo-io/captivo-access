// Why a recording could not be played, in words a person can act on.
//
// The recording routes answer 503 with a reason (`connector_offline`, `no_connector`)
// precisely so the console can say which; a player that only prints the HTTP status
// text ("Service Unavailable") throws that away. Pure, shared by the players.

export const OFFLINE_MESSAGE = "This recording's connector is offline. The recording is intact and plays as soon as the connector is back.";

/** The message for a failed fetch of a recording stream: the status and, when the server gave one, its reason. */
export function unreachableMessage(status: number, reason: string | undefined, fallback: string): string {
  if (status === 503 && reason === "connector_offline") return OFFLINE_MESSAGE;
  if (status === 503 && reason === "no_connector") return "This recording can't be reached: the resource it came from has no connector, so there is nothing to ask for its bytes.";
  if (status === 503) return "The service could not reach this recording just now. Try again in a moment.";
  if (status === 401) return "Your session has ended. Sign in again to play this recording.";
  if (status === 403) return "Your role doesn't allow playing recordings.";
  if (status === 404) return "This recording was not found. It may have been erased.";
  return `${fallback} (HTTP ${status})`;
}

/**
 * Asks the server why a stream failed. Some players (Guacamole's tunnel) never see
 * the response, only that it failed, so after the fact the same address is asked
 * again and only its head is read; a stream that turns out to be fine is dropped
 * unread and the caller's own message stands.
 */
export async function explainFailure(url: string, fallback: string, fetchImpl: typeof fetch = fetch, headers?: Record<string, string>): Promise<string> {
  const ctl = new AbortController();
  try {
    const res = await fetchImpl(url, { signal: ctl.signal, cache: "no-store", ...(headers ? { headers } : {}) });
    if (res.ok) return fallback;
    const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
    return unreachableMessage(res.status, typeof body?.error === "string" ? body.error : undefined, fallback);
  } catch {
    return fallback;
  } finally {
    ctl.abort();
  }
}

/** "17 h ago", "3 days ago": how long a connector has been silent. */
export function silentFor(lastSeen: Date | null, now: Date): string {
  if (!lastSeen) return "never seen";
  const min = Math.max(0, Math.round((now.getTime() - lastSeen.getTime()) / 60_000));
  if (min < 2) return "just now";
  if (min < 120) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}
