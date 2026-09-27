import { fetchWithTimeout } from "@/lib/net/fetch-timeout";

/**
 * Ceiling for a call to OUR OWN data plane, which runs beside the manager and
 * answers these from memory (session registry, watch status, file list). A wait
 * longer than this means that process is wedged, not busy, and a request must not
 * hang on it -- Node's fetch applies no ceiling of its own.
 */
const DP_TIMEOUT_MS = 5_000;

// Reuses the existing manager→data-plane internal env (same one lib/connector/
// dataplane.ts uses) so no new configuration is needed on any deployment.
const BASE = () => (process.env.DATAPLANE_URL || "http://access-dataplane:3102").replace(/\/+$/, "");
function authHeaders(): Record<string, string> {
  return { "content-type": "application/json", "x-dataplane-secret": process.env.DATAPLANE_SECRET ?? "" };
}

export interface ActiveSession {
  sessionId: string;
  siteId: string;
  userId: string;
  kind: "gateway" | "isolated";
  protocol: string;
  host: string;
  startedAt: string;
  viewerCount: number;
  controlOwner: string;
}

export async function listActiveSessions(): Promise<ActiveSession[]> {
  try {
    const res = await fetchWithTimeout(`${BASE()}/sessions`, { timeoutMs: DP_TIMEOUT_MS, headers: authHeaders(), cache: "no-store" });
    if (!res.ok) return [];
    const data = (await res.json()) as ActiveSession[] | null;
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

export interface WebSession {
  userId: string;
  siteId: string;
  host: string;
  startedAt: string;
  lastSeen: string;
}

export async function listActiveWebSessions(): Promise<WebSession[]> {
  try {
    const res = await fetchWithTimeout(`${BASE()}/web-sessions`, { timeoutMs: DP_TIMEOUT_MS, headers: authHeaders(), cache: "no-store" });
    if (!res.ok) return [];
    const data = (await res.json()) as WebSession[] | null;
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

export async function setSessionControl(
  sessionId: string,
  ownerUserId: string,
  action: "take" | "release",
): Promise<{ ok: boolean; reason?: string }> {
  try {
    const res = await fetchWithTimeout(`${BASE()}/sessions/control`, { timeoutMs: DP_TIMEOUT_MS,
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ sessionId, ownerUserId, action }),
      cache: "no-store",
    });
    if (!res.ok) return { ok: false, reason: "unreachable" };
    return (await res.json()) as { ok: boolean; reason?: string };
  } catch {
    return { ok: false, reason: "unreachable" };
  }
}

export async function getWatchStatus(userId: string, siteId: string): Promise<{ watching: boolean; controlHeld: boolean }> {
  try {
    const qs = `userId=${encodeURIComponent(userId)}&siteId=${encodeURIComponent(siteId)}`;
    const res = await fetchWithTimeout(`${BASE()}/sessions/watch-status?${qs}`, { timeoutMs: DP_TIMEOUT_MS, headers: authHeaders(), cache: "no-store" });
    if (!res.ok) return { watching: false, controlHeld: false };
    return (await res.json()) as { watching: boolean; controlHeld: boolean };
  } catch {
    return { watching: false, controlHeld: false };
  }
}

export interface IsolatedDownload { name: string; size: number; mtime: number }

export async function listIsolatedDownloads(userId: string, siteId: string): Promise<IsolatedDownload[]> {
  try {
    const qs = `op=list&userId=${encodeURIComponent(userId)}&siteId=${encodeURIComponent(siteId)}`;
    const res = await fetchWithTimeout(`${BASE()}/kasm-files?${qs}`, { timeoutMs: DP_TIMEOUT_MS, headers: authHeaders(), cache: "no-store" });
    if (!res.ok) return [];
    const data = (await res.json()) as IsolatedDownload[] | null;
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

// Base URL + secret header for the streaming file-transfer routes (upload/download),
// which proxy raw bodies rather than JSON.
export function dataplaneFilesUrl(qs: string): string { return `${BASE()}/kasm-files?${qs}`; }
export function dataplaneSecretHeader(): Record<string, string> { return { "x-dataplane-secret": process.env.DATAPLANE_SECRET ?? "" }; }

export async function terminateSession(sessionId: string): Promise<{ ok: boolean; found: boolean }> {
  try {
    const res = await fetchWithTimeout(`${BASE()}/sessions/terminate`, { timeoutMs: DP_TIMEOUT_MS,
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ sessionId }),
      cache: "no-store",
    });
    if (!res.ok) return { ok: false, found: false };
    return (await res.json()) as { ok: boolean; found: boolean };
  } catch {
    return { ok: false, found: false };
  }
}
