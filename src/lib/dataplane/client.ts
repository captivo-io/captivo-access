import { fetchWithTimeout } from "@/lib/net/fetch-timeout";
import { db } from "@/lib/db";

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
  /** From dataplanes since 2.28: the user's address, what is captured, input in 5 s buckets over 2 min. */
  clientIp?: string;
  recording?: boolean;
  keystrokes?: boolean;
  activity?: number[];
  /** A native RDP client on the RD Gateway (2.39+): nothing to watch or record, only to end. */
  native?: boolean;
}

export interface LiveFeedEvent { at: string; type: string; text: string }
export interface LiveMessage { id: string; text: string; at: string }

// The data plane holds every tenant's sessions in one registry. On Cloud an
// unfiltered list showed one workspace's admin another's live sessions, with
// the ids that watch, control and terminate act on. Every list below keeps only
// sessions on a site the CURRENT tenant can see (RLS), and every action checks
// the same first, so no caller can forget to.
async function ownSiteIds(siteIds: string[]): Promise<Set<string>> {
  const ids = [...new Set(siteIds.filter(Boolean))];
  if (ids.length === 0) return new Set();
  const rows = await db.site.findMany({ where: { id: { in: ids } }, select: { id: true } });
  return new Set(rows.map((r) => r.id));
}

export async function listActiveSessions(): Promise<ActiveSession[]> {
  const all = await fetchAllSessions();
  const own = await ownSiteIds(all.map((s) => s.siteId));
  return all.filter((s) => own.has(s.siteId));
}

/** The current tenant's live session with this id, or null. */
export async function findOwnSession(sessionId: string): Promise<ActiveSession | null> {
  if (!sessionId) return null;
  return (await listActiveSessions()).find((s) => s.sessionId === sessionId) ?? null;
}

/** Sessions in every workspace together -- for the platform operator only, it names nobody. */
export async function countAllLiveSessions(): Promise<number> {
  const [a, b] = await Promise.all([fetchAllSessions(), fetchAllWebSessions()]);
  return a.length + b.length;
}

async function fetchAllSessions(): Promise<ActiveSession[]> {
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
  /** The tab an admin can watch live (/live/web/<liveKey>); absent when the site does not record. */
  liveKey?: string;
  viewers?: number;
}

/** The current tenant's web app tab with this live key, or null. */
export async function findOwnWebSession(liveKey: string): Promise<WebSession | null> {
  if (!liveKey) return null;
  return (await listActiveWebSessions()).find((s) => s.liveKey === liveKey) ?? null;
}

export async function listActiveWebSessions(): Promise<WebSession[]> {
  const all = await fetchAllWebSessions();
  const own = await ownSiteIds(all.map((s) => s.siteId));
  return all.filter((s) => own.has(s.siteId));
}

async function fetchAllWebSessions(): Promise<WebSession[]> {
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
  if (!(await findOwnSession(sessionId))) return { ok: false, reason: "not_found" };
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

/**
 * A live session's recent events (newest first): null when it has ended,
 * "unavailable" when the data plane did not answer (try again).
 */
export async function getSessionFeed(sessionId: string): Promise<LiveFeedEvent[] | null | "unavailable"> {
  if (!(await findOwnSession(sessionId))) return null;
  try {
    const res = await fetchWithTimeout(`${BASE()}/sessions/feed?sessionId=${encodeURIComponent(sessionId)}`, { timeoutMs: DP_TIMEOUT_MS, headers: authHeaders(), cache: "no-store" });
    if (res.status === 404) return null;
    if (!res.ok) return "unavailable";
    const body = (await res.json()) as { events?: LiveFeedEvent[] };
    return Array.isArray(body.events) ? body.events : [];
  } catch {
    return "unavailable";
  }
}

/** Show a message on the user's screen in a live session of this workspace. */
export async function sendSessionMessage(sessionId: string, text: string): Promise<LiveMessage | null> {
  if (!(await findOwnSession(sessionId))) return null;
  try {
    const res = await fetchWithTimeout(`${BASE()}/sessions/message`, {
      timeoutMs: DP_TIMEOUT_MS, method: "POST", headers: authHeaders(), cache: "no-store",
      body: JSON.stringify({ sessionId, text }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { ok?: boolean; message?: LiveMessage };
    return body.ok && body.message ? body.message : null;
  } catch {
    return null;
  }
}

export async function getWatchStatus(userId: string, siteId: string): Promise<{ watching: boolean; controlHeld: boolean; ended?: string; message?: LiveMessage | null }> {
  try {
    const qs = `userId=${encodeURIComponent(userId)}&siteId=${encodeURIComponent(siteId)}`;
    const res = await fetchWithTimeout(`${BASE()}/sessions/watch-status?${qs}`, { timeoutMs: DP_TIMEOUT_MS, headers: authHeaders(), cache: "no-store" });
    if (!res.ok) return { watching: false, controlHeld: false };
    // ended: why the access recheck closed this vendor's session here (dataplane/recheck.go);
    // message: an admin's recent message for the session page to show.
    return (await res.json()) as { watching: boolean; controlHeld: boolean; ended?: string; message?: LiveMessage | null };
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
  if (!(await findOwnSession(sessionId))) return { ok: true, found: false };
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
