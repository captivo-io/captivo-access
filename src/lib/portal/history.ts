import { db } from "@/lib/db";
import { listRecordings } from "@/lib/recording/query";
import { siteTile, SITE_TILE_SELECT } from "@/lib/access/grant-rows";
import { launchHref } from "@/lib/portal/launch-href";
import { sessionsFromAudit, withoutRecorded, type SiteMode } from "./history-sessions";
import type { HistoryRowJSON } from "./history-view";

export type { HistoryRowJSON } from "./history-view";

export const HISTORY_WINDOW_DAYS = 7;
// A week of one person's sessions; far beyond what anyone opens by hand.
const WINDOW_ROWS = 500;
// A week of one person's audit lines (a web app logs every request).
const WINDOW_EVENTS = 20_000;
// A session that starts in the window may close after it.
const CLOSE_LOOKAHEAD_MS = 86_400_000;

export interface HistoryWindow {
  rows: HistoryRowJSON[];
  /** Start of the window, ISO: the next "Show earlier" asks for the days before it. */
  from: string;
  /** Older sessions exist. */
  more: boolean;
}

type SiteRow = Awaited<ReturnType<typeof loadSites>>[number];

function loadSites(ids: string[]) {
  return ids.length ? db.site.findMany({ where: { id: { in: ids } }, select: { ...SITE_TILE_SELECT, hostname: true } }) : Promise.resolve([]);
}

function siteFields(s: SiteRow, native: boolean): Pick<HistoryRowJSON, "siteId" | "name" | "kind" | "proto" | "via" | "tile" | "href"> {
  const t = siteTile(s);
  return {
    siteId: s.id, name: s.name, kind: t.remote ? "remote" : "web", proto: t.proto,
    via: native ? "native" : s.accessMode === "ISOLATED" ? "isolated" : s.accessMode === "GATEWAY" ? "gateway" : null,
    tile: { icon: t.icon, color: t.color, logoUrl: t.logoUrl, logoBg: t.logoBg },
    href: (s.accessMode === "TRANSPARENT" && !s.hostname) || s.accessMode === "DATABASE" || s.accessMode === "TUNNEL" || s.accessMode === "KUBERNETES" ? null : launchHref(s.accessMode, s.id, s.hostname ?? ""),
  };
}

/**
 * The given user's own sessions that started in the days before `until`,
 * newest first: every recorded session (from its recording), and every other
 * one the access audit log shows (unrecorded resources, native RDP clients,
 * and sessions whose recording has since been deleted).
 */
export async function historyWindow(userId: string, until: Date, days = HISTORY_WINDOW_DAYS): Promise<HistoryWindow> {
  const from = new Date(until.getTime() - days * 86_400_000);
  const eventsTo = new Date(Math.min(until.getTime() + CLOSE_LOOKAHEAD_MS, Date.now() + 60_000));
  const sessionReason = { OR: [{ reason: null }, { reason: "" }, { reason: { startsWith: "session_" } }] };
  const [{ rows: recs }, events, olderRec, olderAudit] = await Promise.all([
    listRecordings({ userId, from, to: until, limit: WINDOW_ROWS, offset: 0 }),
    db.auditEvent.findMany({
      where: { userId, decision: "ALLOW", timestamp: { gte: from, lt: eventsTo }, ...sessionReason },
      select: { timestamp: true, siteId: true, siteName: true, reason: true, path: true },
      orderBy: { timestamp: "asc" },
      take: WINDOW_EVENTS,
    }),
    db.sessionRecording.findFirst({ where: { userId, startedAt: { lt: from } }, select: { id: true } }),
    db.auditEvent.findFirst({ where: { userId, decision: "ALLOW", timestamp: { lt: from }, reason: { startsWith: "session_open" } }, select: { id: true } }),
  ]);

  const siteIds = [...new Set([...recs.map((r) => r.siteId), ...events.map((e) => e.siteId).filter((x): x is string => !!x)])];
  const byId = new Map((await loadSites(siteIds)).map((s) => [s.id, s]));

  const recWindows = recs.map((r) => {
    const end = r.lastEventAt.getTime() > r.startedAt.getTime() ? r.lastEventAt : r.startedAt;
    const durationMs = r.durationMs ?? end.getTime() - r.startedAt.getTime();
    return { r, durationMs, endedAt: new Date(r.startedAt.getTime() + durationMs) };
  });

  const rows: HistoryRowJSON[] = recWindows.map(({ r, durationMs, endedAt }) => {
    const s = byId.get(r.siteId);
    const times = { startedAt: r.startedAt.toISOString(), endedAt: endedAt.toISOString(), durationMs };
    if (s) return { id: r.id, ...siteFields(s, false), ...times };
    const remote = r.format === "GUAC" || r.format === "RDP";
    return {
      id: r.id, siteId: null, name: r.host, kind: remote ? "remote" : "web",
      proto: (r.protocol ?? (remote ? "REMOTE" : "WEB")).toUpperCase(), via: null, tile: null, href: null, ...times,
    };
  });

  const audited = withoutRecorded(
    sessionsFromAudit(events.map((e) => ({ at: e.timestamp, siteId: e.siteId, siteName: e.siteName, reason: e.reason, path: e.path })),
      (id) => byId.get(id)?.accessMode as SiteMode | undefined),
    recWindows.map(({ r, endedAt }) => ({ siteId: r.siteId, startedAt: r.startedAt, endedAt })),
  ).filter((a) => a.startedAt >= from && a.startedAt < until);

  for (const a of audited) {
    const s = byId.get(a.siteId);
    const times = { startedAt: a.startedAt.toISOString(), endedAt: a.endedAt.toISOString(), durationMs: a.endedAt.getTime() - a.startedAt.getTime() };
    const id = `a-${a.siteId}-${a.startedAt.getTime()}`;
    if (s) { rows.push({ id, ...siteFields(s, a.native), ...times }); continue; }
    const remote = a.mode === "GATEWAY";
    rows.push({
      id, siteId: null, name: a.siteName ?? "Deleted resource", kind: remote ? "remote" : "web",
      proto: remote ? (a.native ? "RDP" : "REMOTE") : "WEB", via: a.native ? "native" : a.mode === "ISOLATED" ? "isolated" : null,
      tile: null, href: null, ...times,
    });
  }

  rows.sort((x, y) => Date.parse(y.startedAt) - Date.parse(x.startedAt));
  return { from: from.toISOString(), more: olderRec !== null || olderAudit !== null, rows: rows.slice(0, WINDOW_ROWS) };
}
