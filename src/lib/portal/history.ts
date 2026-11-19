import { db } from "@/lib/db";
import { listRecordings } from "@/lib/recording/query";
import { siteTile, SITE_TILE_SELECT } from "@/lib/access/grant-rows";
import { launchHref } from "@/lib/portal/launch-href";
import type { HistoryRowJSON } from "./history-view";

export type { HistoryRowJSON } from "./history-view";

export const HISTORY_WINDOW_DAYS = 7;
// A week of one person's sessions; far beyond what anyone opens by hand.
const WINDOW_ROWS = 500;

export interface HistoryWindow {
  rows: HistoryRowJSON[];
  /** Start of the window, ISO: the next "Show earlier" asks for the days before it. */
  from: string;
  /** Older sessions exist. */
  more: boolean;
}

/**
 * The given user's own sessions that started in the days before `until`,
 * newest first. A session is a recording row, so only recorded sessions count.
 */
export async function historyWindow(userId: string, until: Date, days = HISTORY_WINDOW_DAYS): Promise<HistoryWindow> {
  const from = new Date(until.getTime() - days * 86_400_000);
  const [{ rows }, older] = await Promise.all([
    listRecordings({ userId, from, to: until, limit: WINDOW_ROWS, offset: 0 }),
    db.sessionRecording.findFirst({ where: { userId, startedAt: { lt: from } }, select: { id: true } }),
  ]);
  const siteIds = [...new Set(rows.map((r) => r.siteId))];
  const sites = siteIds.length
    ? await db.site.findMany({ where: { id: { in: siteIds } }, select: { ...SITE_TILE_SELECT, hostname: true } })
    : [];
  const byId = new Map(sites.map((s) => [s.id, s]));

  return {
    from: from.toISOString(),
    more: older !== null,
    rows: rows.map((r): HistoryRowJSON => {
      const s = byId.get(r.siteId);
      const end = r.lastEventAt.getTime() > r.startedAt.getTime() ? r.lastEventAt : r.startedAt;
      const durationMs = r.durationMs ?? end.getTime() - r.startedAt.getTime();
      const endedAt = new Date(r.startedAt.getTime() + durationMs).toISOString();
      if (!s) {
        const remote = r.format === "GUAC";
        return {
          id: r.id, siteId: null, name: r.host, kind: remote ? "remote" : "web",
          proto: (r.protocol ?? (remote ? "REMOTE" : "WEB")).toUpperCase(), via: null,
          startedAt: r.startedAt.toISOString(), endedAt, durationMs, tile: null, href: null,
        };
      }
      const t = siteTile(s);
      return {
        id: r.id, siteId: s.id, name: s.name, kind: t.remote ? "remote" : "web", proto: t.proto,
        via: s.accessMode === "ISOLATED" ? "isolated" : s.accessMode === "GATEWAY" ? "gateway" : null,
        startedAt: r.startedAt.toISOString(), endedAt, durationMs,
        tile: { icon: t.icon, color: t.color, logoUrl: t.logoUrl, logoBg: t.logoBg },
        href: s.accessMode === "TRANSPARENT" && !s.hostname ? null : launchHref(s.accessMode, s.id, s.hostname ?? ""),
      };
    }),
  };
}
