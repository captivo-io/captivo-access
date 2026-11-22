import { describe, it, expect } from "vitest";
import { grantKind, grantState, isPermanent, endsSoon, grantKpis, matchesFilter, limitedEndsAt, limitDays, type GrantFacts } from "./grant-view";

const now = new Date("2026-11-18T12:00:00Z");
const base: GrantFacts = { status: "ACTIVE", startsAt: null, endsAt: null, schedule: null, requiresApproval: false, approvedAt: null };
const h = (n: number) => new Date(now.getTime() + n * 3_600_000);

describe("grant view", () => {
  it("names the kind", () => {
    expect(grantKind(base)).toBe("permanent");
    expect(grantKind({ ...base, endsAt: h(2) })).toBe("timed");
    expect(grantKind({ ...base, endsAt: h(2), schedule: { days: [1] } })).toBe("recurring");
  });

  it("sorts grants into active, scheduled, ended and pending", () => {
    expect(grantState(base, now).state).toBe("active");
    expect(grantState({ ...base, startsAt: h(3) }, now)).toEqual({ state: "scheduled", reason: "not_yet" });
    // A request for a later window waits on a decision; it is not scheduled access.
    expect(grantState({ ...base, startsAt: h(3), requiresApproval: true, approvedAt: null }, now)).toEqual({ state: "pending", reason: "pending_approval" });
    const off = { timezone: "UTC", days: [0], start: "01:00", end: "02:00" }; // Sundays only; now is a Wednesday
    expect(grantState({ ...base, schedule: off }, now)).toEqual({ state: "scheduled", reason: "off_schedule" });
    expect(grantState({ ...base, endsAt: h(-1) }, now)).toEqual({ state: "ended", reason: "expired" });
    expect(grantState({ ...base, status: "REVOKED" }, now).state).toBe("ended");
    expect(grantState({ ...base, status: "DENIED" }, now).state).toBe("ended");
    expect(grantState({ ...base, requiresApproval: true }, now).state).toBe("pending");
  });

  it("counts only live grants without an end as permanent", () => {
    expect(isPermanent(base, "active")).toBe(true);
    expect(isPermanent(base, "scheduled")).toBe(true);
    expect(isPermanent(base, "ended")).toBe(false);
    expect(isPermanent({ endsAt: h(5) }, "active")).toBe(false);
  });

  it("flags live grants that end within a day", () => {
    expect(endsSoon({ endsAt: h(23) }, "active", now)).toBe(true);
    expect(endsSoon({ endsAt: h(25) }, "active", now)).toBe(false);
    expect(endsSoon({ endsAt: h(-1) }, "ended", now)).toBe(false);
    expect(endsSoon({ endsAt: null }, "active", now)).toBe(false);
  });

  it("tallies the strip and filters", () => {
    const rows = [
      { userId: "a", state: "active" as const, permanent: true, soon: false },
      { userId: "a", state: "active" as const, permanent: false, soon: true },
      { userId: "b", state: "scheduled" as const, permanent: false, soon: false },
      { userId: "b", state: "ended" as const, permanent: false, soon: false },
      { userId: "c", state: "pending" as const, permanent: true, soon: false },
    ];
    expect(grantKpis(rows)).toEqual({ all: 4, active: 2, activePeople: 1, perm: 2, scheduled: 1, ended: 1, soon: 1, live: 3 });
    expect(matchesFilter(rows[4], "all")).toBe(false); // pending requests have their own card
  });

  it("limits without pushing an earlier end out", () => {
    expect(limitedEndsAt(null, now, 30)).toEqual(new Date(now.getTime() + 30 * 86_400_000));
    expect(limitedEndsAt(h(5), now, 30)).toBeNull();
    expect(limitedEndsAt(h(24 * 40), now, 30)).toEqual(new Date(now.getTime() + 30 * 86_400_000));
    expect(limitDays(30, 0)).toBe(30);
    expect(limitDays(30, 7)).toBe(7);
  });
});
