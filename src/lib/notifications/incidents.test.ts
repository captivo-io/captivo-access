import { describe, it, expect } from "vitest";
import { pairIncidents, incidentStats, durationLabel, stripSegment, type NotificationLike } from "./incidents";

const at = (h: number) => new Date(Date.UTC(2026, 10, 18, 0, 0) + h * 3600_000).toISOString();
let n = 0;
const row = (type: "site_down" | "site_recovered", h: number, o: Partial<NotificationLike> = {}): NotificationLike =>
  ({ id: `n${++n}`, type, siteId: "s1", siteName: "WP-SSH", detail: type === "site_down" ? "timeout" : null, createdAt: at(h), readAt: null, ...o });

describe("pairIncidents", () => {
  it("merges a down and the next recovery into one incident, newest first", () => {
    const rows = [row("site_down", 1), row("site_recovered", 2), row("site_down", 5, { detail: "connector offline" })];
    const inc = pairIncidents(rows);
    expect(inc).toHaveLength(2);
    expect(inc[0]).toMatchObject({ downAt: at(5), upAt: null, reason: "connector offline", rowIds: [rows[2].id] });
    expect(inc[1]).toMatchObject({ id: rows[0].id, downAt: at(1), upAt: at(2), reason: "timeout", rowIds: [rows[0].id, rows[1].id] });
  });

  it("keeps resources apart, and pairs by name when the site id is gone", () => {
    const inc = pairIncidents([
      row("site_down", 1), row("site_down", 1.5, { siteId: "s2", siteName: "DC-RDP" }),
      row("site_recovered", 2, { siteId: "s2", siteName: "DC-RDP" }),
      row("site_down", 3, { siteId: null, siteName: "Old" }), row("site_recovered", 4, { siteId: null, siteName: "Old" }),
    ]);
    expect(inc.map((i) => [i.siteName, i.upAt !== null])).toEqual([["Old", true], ["DC-RDP", true], ["WP-SSH", false]]);
  });

  it("a recovery with no open down is a resolved incident with no start; a repeated down joins the open one", () => {
    const rows = [row("site_recovered", 1), row("site_down", 2), row("site_down", 3), row("site_recovered", 4)];
    const inc = pairIncidents(rows);
    expect(inc).toHaveLength(2);
    expect(inc[0]).toMatchObject({ downAt: at(2), upAt: at(4), rowIds: [rows[1].id, rows[2].id, rows[3].id] });
    expect(inc[1]).toMatchObject({ downAt: null, upAt: at(1) });
  });

  it("is read only when every row is read", () => {
    const inc = pairIncidents([row("site_down", 1, { readAt: at(1) }), row("site_recovered", 2)]);
    expect(inc[0].read).toBe(false);
    expect(pairIncidents([row("site_down", 1, { readAt: at(1) }), row("site_recovered", 2, { readAt: at(2) })])[0].read).toBe(true);
  });
});

describe("incidentStats / durationLabel / stripSegment", () => {
  const now = new Date(at(48)).getTime();
  it("counts incidents touching the last 24 h and the mean time to recover", () => {
    const inc = pairIncidents([row("site_down", 1), row("site_recovered", 3), row("site_down", 30), row("site_recovered", 31), row("site_down", 47)]);
    expect(incidentStats(inc, now)).toEqual({ last24h: 2, mttrMs: 1.5 * 3600_000 });
    expect(incidentStats([], now).mttrMs).toBeNull();
  });
  it("labels durations", () => {
    expect(durationLabel(3 * 3600_000 + 12 * 60_000)).toBe("3h 12m");
    expect(durationLabel(45 * 60_000)).toBe("45m");
  });
  it("places the outage on the 48-hour strip", () => {
    const [ongoing] = pairIncidents([row("site_down", 42)]);
    expect(stripSegment(ongoing, now)).toEqual({ left: 87.5, width: 12.5 });
    const [old] = pairIncidents([row("site_down", -10), row("site_recovered", -5)]);
    expect(stripSegment(old, now)).toBeNull();
    const [clipped] = pairIncidents([row("site_down", -2), row("site_recovered", 12)]);
    expect(stripSegment(clipped, now)).toEqual({ left: 0, width: 25 });
  });
});
