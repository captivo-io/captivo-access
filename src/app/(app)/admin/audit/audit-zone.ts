"use client";

import { useEffect, useState } from "react";
import { useTimezone } from "@/app/(app)/_shell/timezone-context";

/**
 * The zone the page formats in: the configured display zone, else the
 * browser's. Before mount it is UTC (like LocalTime) so the server render and
 * the first client render agree.
 */
export function useZone(): string {
  const tz = useTimezone();
  const [browser, setBrowser] = useState<string | null>(null);
  useEffect(() => setBrowser(Intl.DateTimeFormat().resolvedOptions().timeZone), []);
  return tz ?? browser ?? "UTC";
}

export function fmt(iso: string | number, zone: string, opts: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: zone, ...opts }).format(new Date(iso));
}

export const clock = (iso: string | number, zone: string) => fmt(iso, zone, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
export const hm = (iso: string | number, zone: string) => fmt(iso, zone, { hour: "2-digit", minute: "2-digit", hour12: false });

/** "WED · NOV 18, 2026" */
export function dayLabel(iso: string, zone: string): string {
  const d = new Date(iso);
  const wd = new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "short" }).format(d);
  const md = new Intl.DateTimeFormat("en-US", { timeZone: zone, month: "short", day: "numeric", year: "numeric" }).format(d);
  return `${wd} · ${md}`.toUpperCase();
}

export const dayKey = (iso: string, zone: string) => fmt(iso, zone, { year: "numeric", month: "2-digit", day: "2-digit" });

/** "2026-11-18T00:58:41+03:00" in the zone. */
export function isoWithOffset(iso: string, zone: string): string {
  const d = new Date(iso);
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, timeZoneName: "longOffset",
  }).formatToParts(d).map((p) => [p.type, p.value]));
  const off = (parts.timeZoneName ?? "GMT").replace("GMT", "") || "+00:00";
  const hour = parts.hour === "24" ? "00" : parts.hour;
  return `${parts.year}-${parts.month}-${parts.day}T${hour}:${parts.minute}:${parts.second}${off}`;
}
