import { describe, it, expect } from "vitest";
import { validateSchedule, parseSchedule, isWithinSchedule, formatSchedule, compactDays, nextScheduleStart, type Schedule } from "./schedule";

const weekdays: Schedule = { timezone: "Europe/Istanbul", days: [1, 2, 3, 4, 5], start: "09:00", end: "18:00" };

describe("validateSchedule", () => {
  it("accepts a well-formed schedule and dedupes/sorts days", () => {
    const r = validateSchedule({ timezone: "UTC", days: [5, 1, 1, 3], start: "09:00", end: "17:30" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.schedule.days).toEqual([1, 3, 5]);
  });
  it("rejects an invalid timezone", () => {
    expect(validateSchedule({ timezone: "Mars/Phobos", days: [1], start: "09:00", end: "10:00" }).ok).toBe(false);
  });
  it("rejects empty days and out-of-range days", () => {
    expect(validateSchedule({ timezone: "UTC", days: [], start: "09:00", end: "10:00" }).ok).toBe(false);
    expect(validateSchedule({ timezone: "UTC", days: [7], start: "09:00", end: "10:00" }).ok).toBe(false);
  });
  it("rejects malformed and inverted times", () => {
    expect(validateSchedule({ timezone: "UTC", days: [1], start: "9:00", end: "10:00" }).ok).toBe(false);
    expect(validateSchedule({ timezone: "UTC", days: [1], start: "18:00", end: "09:00" }).ok).toBe(false);
    expect(validateSchedule({ timezone: "UTC", days: [1], start: "09:00", end: "09:00" }).ok).toBe(false);
  });
});

describe("parseSchedule", () => {
  it("returns null for a malformed value", () => {
    expect(parseSchedule({ timezone: "UTC" })).toBeNull();
    expect(parseSchedule(null)).toBeNull();
  });
  it("returns the schedule for a valid value", () => {
    expect(parseSchedule(weekdays)?.timezone).toBe("Europe/Istanbul");
  });
});

describe("isWithinSchedule", () => {
  it("allows a matching weekday within hours (Istanbul)", () => {
    // 2026-08-03 is a Monday. 12:00 Istanbul = 09:00 UTC (UTC+3, no DST in TR).
    expect(isWithinSchedule(weekdays, new Date("2026-08-03T09:00:00Z"))).toBe(true);
  });
  it("denies outside hours", () => {
    // 2026-08-03 05:00 UTC = 08:00 Istanbul → before 09:00
    expect(isWithinSchedule(weekdays, new Date("2026-08-03T05:00:00Z"))).toBe(false);
  });
  it("denies on a non-listed weekday", () => {
    // 2026-08-02 is a Sunday
    expect(isWithinSchedule(weekdays, new Date("2026-08-02T12:00:00Z"))).toBe(false);
  });
  it("resolves by LOCAL weekday across the date line", () => {
    // 2026-08-02T23:30Z is Sunday in UTC but Monday 02:30 in Istanbul (UTC+3).
    const mondayOnly: Schedule = { timezone: "Europe/Istanbul", days: [1], start: "00:00", end: "23:59" };
    expect(isWithinSchedule(mondayOnly, new Date("2026-08-02T23:30:00Z"))).toBe(true);
    const sundayOnly: Schedule = { ...mondayOnly, days: [0] };
    expect(isWithinSchedule(sundayOnly, new Date("2026-08-02T23:30:00Z"))).toBe(false);
  });
  it("honors DST in a zone that observes it", () => {
    // New York is UTC-4 in August (EDT). 2026-08-03 13:00Z = 09:00 EDT (Monday).
    const nyBiz: Schedule = { timezone: "America/New_York", days: [1], start: "09:00", end: "17:00" };
    expect(isWithinSchedule(nyBiz, new Date("2026-08-03T13:00:00Z"))).toBe(true);
    expect(isWithinSchedule(nyBiz, new Date("2026-08-03T12:59:00Z"))).toBe(false);
  });
});

describe("formatSchedule", () => {
  it("summarizes days, hours, and zone", () => {
    expect(formatSchedule(weekdays)).toBe("Mon, Tue, Wed, Thu, Fri 09:00–18:00 (Europe/Istanbul)");
  });
});

describe("compactDays / nextScheduleStart", () => {
  it("joins runs of days", () => {
    expect(compactDays([1, 2, 3, 4, 5])).toBe("Mon–Fri");
    expect(compactDays([1, 3, 5])).toBe("Mon, Wed, Fri");
    expect(compactDays([6, 0])).toBe("Sat, Sun");
    expect(compactDays([0, 1, 2, 3, 4, 5, 6])).toBe("Every day");
  });
  it("finds the next opening in the schedule's zone", () => {
    const s = { timezone: "Europe/Istanbul", days: [1, 2, 3, 4, 5], start: "09:00", end: "18:00" };
    // Wed 2026-11-18 20:00 Istanbul → Thu 09:00 Istanbul (06:00Z)
    expect(nextScheduleStart(s, new Date("2026-11-18T17:00:00Z"))?.toISOString()).toBe("2026-11-19T06:00:00.000Z");
    // Fri 20:00 → Mon 09:00
    expect(nextScheduleStart(s, new Date("2026-11-20T17:00:00Z"))?.toISOString()).toBe("2026-11-23T06:00:00.000Z");
    // inside today's window → tomorrow's start
    expect(nextScheduleStart(s, new Date("2026-11-18T08:00:00Z"))?.toISOString()).toBe("2026-11-19T06:00:00.000Z");
  });
});
