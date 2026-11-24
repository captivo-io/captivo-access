// Sessions rebuilt from the access audit log, for Session history. A recording
// row covers only recorded sessions; the audit log has every session's open
// (and, for remote desktop, isolated browser and native RDP, its close with the
// duration), so unrecorded and native sessions show up too. Pure and db-free.

export type SiteMode = "TRANSPARENT" | "GATEWAY" | "ISOLATED";

export interface AuditSessionEvent {
  at: Date;
  siteId: string | null;
  siteName: string | null;
  reason: string | null;
  path: string;
}

export interface AuditSession {
  siteId: string;
  siteName: string | null;
  /** The resource's mode, or the one the paths show once it is deleted. */
  mode: SiteMode;
  native: boolean;
  startedAt: Date;
  endedAt: Date;
}

const RDPGW_PATH = "/remoteDesktopGateway";
// A close says how long the session ran, cut to the second or the minute
// ("45s", "12m", "1h05m"), so its open is within a minute before that.
const MATCH_SLACK_MS = 90_000;

/** The data plane's compactDur back to milliseconds; null if it isn't one. */
export function parseCompactDur(s: string): number | null {
  let m = /^(\d+)s$/.exec(s);
  if (m) return Number(m[1]) * 1000;
  m = /^(\d+)m$/.exec(s);
  if (m) return Number(m[1]) * 60_000;
  m = /^(\d+)h(\d{2})m$/.exec(s);
  if (m) return (Number(m[1]) * 60 + Number(m[2])) * 60_000;
  return null;
}

function modeFromPath(path: string): SiteMode {
  if (path.startsWith("/guac-tunnel") || path.startsWith(RDPGW_PATH)) return "GATEWAY";
  if (path.startsWith("/kasm-tunnel") || path.startsWith("/websockify")) return "ISOLATED";
  return "TRANSPARENT";
}

const isOpen = (r: string | null) => r === "session_open" || r?.startsWith("session_open ") === true;
const isClose = (r: string | null) => r?.startsWith("session_close ") === true;
const isRequest = (r: string | null) => r === null || r === "";

/**
 * One user's sessions from their ALLOW audit events (oldest first).
 *
 * Remote desktop, isolated browser and native RDP: each close is paired with
 * the open its duration points at; a close whose open is outside the events
 * starts where the duration says. An open with no close is still running (or
 * its data plane stopped before writing one) and is left out.
 *
 * Web apps have no close: a span starts at its session_open and lasts until
 * the last request (or relayed WebSocket close) before the next span opens.
 */
export function sessionsFromAudit(events: AuditSessionEvent[], modeOf: (siteId: string) => SiteMode | undefined): AuditSession[] {
  const out: AuditSession[] = [];
  type Open = { at: Date; native: boolean; used: boolean };
  const opens = new Map<string, Open[]>();
  const web = new Map<string, AuditSession>();
  const names = new Map<string, string | null>();

  for (const e of events) {
    if (!e.siteId) continue;
    if (e.siteName) names.set(e.siteId, e.siteName);
    const mode = modeOf(e.siteId) ?? modeFromPath(e.path);
    if (mode === "TRANSPARENT") {
      const cur = web.get(e.siteId);
      if (isOpen(e.reason)) {
        const span: AuditSession = { siteId: e.siteId, siteName: null, mode, native: false, startedAt: e.at, endedAt: e.at };
        out.push(span);
        web.set(e.siteId, span);
      } else if (cur && (isRequest(e.reason) || isClose(e.reason)) && e.at > cur.endedAt) {
        cur.endedAt = e.at;
      }
      continue;
    }
    const native = e.path.startsWith(RDPGW_PATH);
    if (isOpen(e.reason)) {
      const list = opens.get(e.siteId) ?? [];
      list.push({ at: e.at, native: native || e.reason === "session_open native_rdp" || e.reason === "session_open native_ssh" || e.reason === "session_open native_tcp" || e.reason === "session_open database" || e.reason === "session_open kubernetes", used: false });
      opens.set(e.siteId, list);
      continue;
    }
    if (!isClose(e.reason)) continue;
    const dur = parseCompactDur(e.reason!.slice("session_close ".length));
    if (dur === null) continue;
    const target = e.at.getTime() - dur;
    let best: Open | null = null;
    for (const o of opens.get(e.siteId) ?? []) {
      if (o.used || o.at > e.at) continue;
      const off = Math.abs(o.at.getTime() - target);
      if (off <= MATCH_SLACK_MS && (!best || off < Math.abs(best.at.getTime() - target))) best = o;
    }
    if (best) best.used = true;
    out.push({
      siteId: e.siteId, siteName: null, mode, native: best ? best.native : native,
      startedAt: best ? best.at : new Date(target), endedAt: e.at,
    });
  }
  for (const s of out) s.siteName = names.get(s.siteId) ?? null;
  return out;
}

/**
 * Drops the sessions a recording already shows: same resource, and the
 * recording overlaps the session (with a little slack for the moments between
 * the open and the recorder's first write). The recording row is the better
 * one: its duration is exact and an admin can replay it.
 */
export function withoutRecorded(sessions: AuditSession[], recordings: { siteId: string; startedAt: Date; endedAt: Date }[], slackMs = 120_000): AuditSession[] {
  return sessions.filter((s) => !recordings.some((r) =>
    r.siteId === s.siteId &&
    r.startedAt.getTime() <= s.endedAt.getTime() + slackMs &&
    r.endedAt.getTime() >= s.startedAt.getTime() - slackMs));
}
