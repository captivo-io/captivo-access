// Pure, db-free helpers for the Session history page (design hand-off 7.21),
// shared by the server window loader and the client view.

export type HistoryKind = "web" | "remote";

export interface HistoryRowJSON {
  id: string;
  /** Null once the resource has been deleted. */
  siteId: string | null;
  name: string;
  kind: HistoryKind;
  /** HTTPS / HTTP / RDP / SSH / VNC. */
  proto: string;
  /** How the session reached the resource, when it went through Captivo's own client. */
  via: "isolated" | "gateway" | null;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  tile: { icon: string; color: string; logoUrl: string | null; logoBg: string | null } | null;
  /** Where "Open again" goes; null when the resource is gone. */
  href: string | null;
}

/** "<1m" under a minute, else "6m" / "1h 29m". */
export function durationText(ms: number): string {
  if (ms < 60_000) return "<1m";
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

export interface HistorySummary {
  count: number;
  totalMs: number;
  /** The resource opened most often, ties going to the one used most recently. */
  top: { name: string; count: number } | null;
}

/** Rows newest first. */
export function summarize(rows: HistoryRowJSON[]): HistorySummary {
  const counts = new Map<string, number>();
  let totalMs = 0;
  for (const r of rows) {
    totalMs += r.durationMs;
    counts.set(r.name, (counts.get(r.name) ?? 0) + 1);
  }
  let top: HistorySummary["top"] = null;
  for (const [name, count] of counts) if (!top || count > top.count) top = { name, count };
  return { count: rows.length, totalMs, top };
}

export function matches(r: HistoryRowJSON, q: string, kind: "all" | HistoryKind): boolean {
  if (kind !== "all" && r.kind !== kind) return false;
  const t = q.trim().toLowerCase();
  return !t || r.name.toLowerCase().includes(t);
}
