// Resource health notifications come in pairs: a site_down row when the probe
// first fails and a site_recovered row when it answers again. The Notifications
// page shows each pair as one incident. Pure, so it is unit-tested.

export interface NotificationLike {
  id: string;
  type: string; // "site_down" | "site_recovered"
  siteId: string | null;
  siteName: string;
  detail: string | null;
  createdAt: Date | string;
  readAt: Date | string | null;
}

export interface Incident {
  /** The first row's id (the down row when there is one). */
  id: string;
  siteId: string | null;
  siteName: string;
  /** null when the down row is missing (deleted, or older than what was loaded). */
  downAt: string | null;
  /** null while the outage is ongoing. */
  upAt: string | null;
  reason: string | null;
  /** Every row of the incident is read. */
  read: boolean;
  /** The rows to mark read together. */
  rowIds: string[];
}

const iso = (d: Date | string) => (typeof d === "string" ? new Date(d) : d).toISOString();

/**
 * Pairs each site_down with the next site_recovered for the same resource
 * (by siteId, else by name). A second down while one is open joins it; a
 * recovery with no open down becomes a resolved incident with no start.
 * Returns the newest first.
 */
export function pairIncidents(rows: NotificationLike[]): Incident[] {
  const sorted = rows.slice().sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  const open = new Map<string, Incident>();
  const out: Incident[] = [];
  for (const r of sorted) {
    const key = r.siteId ?? `name:${r.siteName}`;
    const cur = open.get(key);
    if (r.type === "site_down") {
      if (cur) {
        cur.rowIds.push(r.id);
        cur.read &&= !!r.readAt;
        continue;
      }
      const inc: Incident = { id: r.id, siteId: r.siteId, siteName: r.siteName, downAt: iso(r.createdAt), upAt: null, reason: r.detail, read: !!r.readAt, rowIds: [r.id] };
      open.set(key, inc);
      out.push(inc);
    } else if (r.type === "site_recovered") {
      if (cur) {
        cur.upAt = iso(r.createdAt);
        cur.rowIds.push(r.id);
        cur.read &&= !!r.readAt;
        open.delete(key);
      } else {
        out.push({ id: r.id, siteId: r.siteId, siteName: r.siteName, downAt: null, upAt: iso(r.createdAt), reason: null, read: !!r.readAt, rowIds: [r.id] });
      }
    }
  }
  const start = (i: Incident) => new Date(i.downAt ?? i.upAt ?? 0).getTime();
  return out.sort((a, b) => start(b) - start(a));
}

const DAY = 24 * 3600_000;

export interface IncidentStats {
  /** Incidents that were going on at any moment of the last 24 hours. */
  last24h: number;
  /** Mean time to recover of the resolved incidents with a known start, ms; null when none. */
  mttrMs: number | null;
}

export function incidentStats(incidents: Incident[], now: number): IncidentStats {
  const since = now - DAY;
  const last24h = incidents.filter((i) => i.upAt === null || new Date(i.upAt).getTime() >= since).length;
  const done = incidents.filter((i) => i.downAt && i.upAt).map((i) => new Date(i.upAt!).getTime() - new Date(i.downAt!).getTime());
  return { last24h, mttrMs: done.length ? done.reduce((a, b) => a + b, 0) / done.length : null };
}

/** "3h 12m", "45m", "0m". */
export function durationLabel(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
}

/**
 * Where the outage sits on a 48-hour strip ending now, as percentages. A
 * resolved incident with no start is a thin mark at its end; one wholly
 * before the window has no segment.
 */
export function stripSegment(i: Incident, now: number): { left: number; width: number } | null {
  const span = 2 * DAY;
  const start = now - span;
  const end = i.upAt ? new Date(i.upAt).getTime() : now;
  const from = i.downAt ? new Date(i.downAt).getTime() : end;
  if (end < start) return null;
  const l = Math.max(from, start);
  return { left: ((l - start) / span) * 100, width: (Math.min(end, now) - l) / span * 100 };
}
