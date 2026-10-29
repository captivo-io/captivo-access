// The traffic heatmap is counted in UTC (EXTRACT on the raw timestamp, see
// insights.ts). The viewer reads it in their own zone, so the grid is rotated
// by that zone's offset. Whole-hour offsets only: a half-hour zone (India,
// +05:30) cannot be re-bucketed from hourly counts, so it stays UTC and says so.

/** Minutes the zone is ahead of UTC at `at` (Istanbul: 180). */
export function zoneOffsetMinutes(tz: string, at: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).formatToParts(at);
  const n = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const asUtc = Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"));
  return Math.round((asUtc - Math.floor(at.getTime() / 60_000) * 60_000) / 60_000);
}

/**
 * The 7×24 UTC grid seen from `tz`, or null when the zone has a part-hour
 * offset (or is unknown) and the grid must stay in UTC.
 */
export function heatmapInZone(grid: number[][], tz: string | null, at: Date): number[][] | null {
  if (!tz || tz === "UTC") return null;
  let offset: number;
  try { offset = zoneOffsetMinutes(tz, at); } catch { return null; }
  if (offset % 60 !== 0) return null;
  const shift = offset / 60;
  const out = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
  for (let dow = 0; dow < 7; dow++) {
    for (let hour = 0; hour < 24; hour++) {
      const slot = dow * 24 + hour + shift;
      const s = ((slot % 168) + 168) % 168;
      out[Math.floor(s / 24)]![s % 24] = grid[dow]?.[hour] ?? 0;
    }
  }
  return out;
}
