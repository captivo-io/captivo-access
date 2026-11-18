// Recurring weekly access window. Timezone handling uses Node's built-in Intl
// (DST-correct) — no external dependency.
import { parseDatetimeLocal } from "@/lib/time/datetime-local";

export type Schedule = {
  timezone: string; // IANA zone, e.g. "Europe/Istanbul"
  days: number[]; // weekdays, 0=Sunday … 6=Saturday (Date.getDay convention)
  start: string; // "HH:MM" 24h local time-of-day
  end: string; // "HH:MM", strictly greater than start (same-day window)
};

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

function timeToMinutes(t: string): number | null {
  const m = TIME_RE.exec(t);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function validateSchedule(
  value: unknown,
): { ok: true; schedule: Schedule } | { ok: false; error: string } {
  if (typeof value !== "object" || value === null) return { ok: false, error: "not_object" };
  const v = value as Record<string, unknown>;

  if (typeof v.timezone !== "string" || !isValidTimeZone(v.timezone)) {
    return { ok: false, error: "bad_timezone" };
  }
  if (!Array.isArray(v.days) || v.days.length === 0) return { ok: false, error: "bad_days" };
  const days: number[] = [];
  for (const d of v.days) {
    if (typeof d !== "number" || !Number.isInteger(d) || d < 0 || d > 6) {
      return { ok: false, error: "bad_days" };
    }
    if (!days.includes(d)) days.push(d);
  }
  days.sort((a, b) => a - b);

  if (typeof v.start !== "string" || typeof v.end !== "string") return { ok: false, error: "bad_time" };
  const s = timeToMinutes(v.start);
  const e = timeToMinutes(v.end);
  if (s === null || e === null) return { ok: false, error: "bad_time" };
  if (s >= e) return { ok: false, error: "start_after_end" };

  return { ok: true, schedule: { timezone: v.timezone, days, start: v.start, end: v.end } };
}

export function parseSchedule(value: unknown): Schedule | null {
  const r = validateSchedule(value);
  return r.ok ? r.schedule : null;
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

export function isWithinSchedule(schedule: Schedule, now: Date): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: schedule.timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);

  let weekday = -1;
  let hour = 0;
  let minute = 0;
  for (const p of parts) {
    if (p.type === "weekday") weekday = WEEKDAY_INDEX[p.value] ?? -1;
    else if (p.type === "hour") hour = Number(p.value === "24" ? "0" : p.value); // Intl may emit "24" for midnight
    else if (p.type === "minute") minute = Number(p.value);
  }
  if (weekday < 0 || !schedule.days.includes(weekday)) return false;

  const nowMin = hour * 60 + minute;
  const s = timeToMinutes(schedule.start);
  const e = timeToMinutes(schedule.end);
  if (s === null || e === null) return false;
  return s <= nowMin && nowMin <= e;
}

const DAY_ABBR = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function formatSchedule(schedule: Schedule): string {
  const days = [...schedule.days].sort((a, b) => a - b).map((d) => DAY_ABBR[d]).join(", ");
  return `${days} ${schedule.start}–${schedule.end} (${schedule.timezone})`;
}

/** "Mon–Fri", "Sat–Sun", "Mon, Wed, Fri": the days, Monday first, runs joined. */
export function compactDays(days: number[]): string {
  const order = [1, 2, 3, 4, 5, 6, 0];
  const on = order.filter((d) => days.includes(d));
  if (on.length === 7) return "Every day";
  const runs: number[][] = [];
  for (const d of on) {
    const last = runs.at(-1);
    if (last && order.indexOf(d) === order.indexOf(last.at(-1)!) + 1) last.push(d);
    else runs.push([d]);
  }
  return runs.map((r) => (r.length >= 3 ? `${DAY_ABBR[r[0]]}–${DAY_ABBR[r.at(-1)!]}` : r.map((d) => DAY_ABBR[d]).join(", "))).join(", ");
}

/**
 * When the schedule next opens after `now` (null when it never does). A window
 * that is open at `now` is not counted: this is the next start.
 */
export function nextScheduleStart(schedule: Schedule, now: Date): Date | null {
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: schedule.timezone, year: "numeric", month: "2-digit", day: "2-digit" });
  for (let i = 0; i <= 7; i++) {
    const probe = new Date(now.getTime() + i * 86_400_000);
    const date = day.format(probe); // YYYY-MM-DD in the schedule's zone
    const at = parseDatetimeLocal(`${date}T${schedule.start}`, schedule.timezone);
    if (!at || at <= now) continue;
    const wd = WEEKDAY_INDEX[new Intl.DateTimeFormat("en-US", { timeZone: schedule.timezone, weekday: "short" }).format(at)];
    if (schedule.days.includes(wd)) return at;
  }
  return null;
}
