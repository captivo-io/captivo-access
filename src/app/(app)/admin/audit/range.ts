// The Audit page's time ranges (design hand-off 7.9). Shared by the server page
// (first render) and the client view (refetches), so both resolve them alike.

export type RangeKey = "1h" | "24h" | "7d" | "custom";

export const RANGES: { key: RangeKey; label: string }[] = [
  { key: "1h", label: "Last hour" },
  { key: "24h", label: "Last 24h" },
  { key: "7d", label: "Last 7 days" },
  { key: "custom", label: "Custom range" },
];

const SPAN: Record<Exclude<RangeKey, "custom">, number> = { "1h": 3_600_000, "24h": 86_400_000, "7d": 7 * 86_400_000 };

export function parseRange(v: string | null | undefined): RangeKey {
  return v === "1h" || v === "7d" || v === "custom" ? v : "24h";
}

const date = (v: string | null | undefined) => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

/** The instants a range covers at `now`. A custom range without both ends falls back to the last day. */
export function resolveRange(range: RangeKey, fromIso: string | null | undefined, toIso: string | null | undefined, now: Date): { from: Date; to: Date } {
  if (range === "custom") {
    const to = date(toIso) ?? now;
    const from = date(fromIso) ?? new Date(to.getTime() - SPAN["24h"]);
    return from < to ? { from, to } : { from: to, to: from };
  }
  return { from: new Date(now.getTime() - SPAN[range]), to: now };
}
