"use client";

import { useEffect, useState } from "react";
import { useTimezone } from "./timezone-context";

export type LocalTimeMode = "datetime" | "time" | "date" | "short" | "shortdate" | "full";

const MODES: Record<LocalTimeMode, Intl.DateTimeFormatOptions> = {
  datetime: { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" },
  time: { hour: "2-digit", minute: "2-digit" },
  date: { year: "numeric", month: "2-digit", day: "2-digit" },
  // Compact, portal-style: "Sep 10, 09:00" / "Sep 10, 2026".
  short: { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false },
  shortdate: { month: "short", day: "numeric", year: "numeric" },
  // A single record, to the second: "Nov 17, 2026, 18:13:07".
  full: { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false },
};

// Renders an ISO timestamp in the configured display timezone (from context), or the
// viewer's own browser timezone when none is set. The initial (SSR / first-hydration)
// value is deterministic — fixed en-GB + UTC — so it is identical on server and
// client (no hydration mismatch); a client-only effect then re-formats it.
export function LocalTime({ iso, mode = "datetime" }: { iso: string; mode?: LocalTimeMode }) {
  const tz = useTimezone();
  const fmt = MODES[mode];
  const [text, setText] = useState(() => new Date(iso).toLocaleString("en-GB", { ...fmt, timeZone: "UTC" }));
  useEffect(() => {
    setText(new Date(iso).toLocaleString(undefined, tz ? { ...fmt, timeZone: tz } : fmt));
  }, [iso, tz, mode, fmt]);
  return (
    <time dateTime={iso} title={iso}>
      {text}
    </time>
  );
}
