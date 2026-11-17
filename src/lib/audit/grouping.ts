// Pure grouping for the Audit page (design hand-off 7.9), run in the browser on
// the rows loaded so far, so a page boundary never splits a group for good.

import { TRANSFER_VERBS } from "./access-format";

export const BURST_GAP_MS = 5 * 60_000;

export interface BurstInput {
  id: string;
  timestamp: string;
  userId: string | null;
  userEmail: string | null;
  siteId: string | null;
  host: string;
  clientIp: string | null;
  method: string;
  decision: "ALLOW" | "DENY";
}

export interface Burst<T extends BurstInput> {
  id: string;
  rows: T[];
  /** Newest and oldest event, ISO. */
  end: string;
  start: string;
  denied: number;
  files: number;
}

const burstKey = (r: BurstInput) => `${r.userId ?? r.userEmail ?? "-"}|${r.siteId ?? r.host}|${r.clientIp ?? "-"}`;

/**
 * Newest-first rows into bursts: consecutive events by the same person on the
 * same resource from the same IP, broken by a gap longer than gapMs.
 */
export function groupBursts<T extends BurstInput>(rows: T[], gapMs = BURST_GAP_MS): Burst<T>[] {
  const out: Burst<T>[] = [];
  let cur: Burst<T> | null = null;
  let key = "";
  for (const r of rows) {
    const k = burstKey(r);
    const gap = cur ? Date.parse(cur.start) - Date.parse(r.timestamp) : Infinity;
    if (!cur || k !== key || gap > gapMs) {
      cur = { id: r.id, rows: [], end: r.timestamp, start: r.timestamp, denied: 0, files: 0 };
      out.push(cur);
      key = k;
    }
    cur.rows.push(r);
    cur.start = r.timestamp;
    if (r.decision === "DENY") cur.denied++;
    if ((TRANSFER_VERBS as readonly string[]).includes(r.method)) cur.files++;
  }
  return out;
}

export interface MergeInput { id: string; timestamp: string; actorEmail: string | null; action: string }

/** Newest-first admin rows: the same admin repeating the same action within a minute merge into one entry. */
export function mergeAdminRows<T extends MergeInput>(rows: T[], windowMs = 60_000): T[][] {
  const out: T[][] = [];
  for (const r of rows) {
    const last = out[out.length - 1];
    const head = last?.[0];
    if (head && head.action === r.action && head.actorEmail === r.actorEmail && Date.parse(head.timestamp) - Date.parse(r.timestamp) <= windowMs) {
      last.push(r);
    } else {
      out.push([r]);
    }
  }
  return out;
}

/** "Chrome · Windows" from a user agent; null when it says nothing useful. */
export function describeAgent(ua: string | null | undefined): string | null {
  if (!ua) return null;
  const browser =
    /Edg\//.test(ua) ? "Edge"
    : /OPR\//.test(ua) ? "Opera"
    : /Firefox\//.test(ua) ? "Firefox"
    : /Chrome\//.test(ua) ? "Chrome"
    : /Safari\//.test(ua) ? "Safari"
    : /^curl\//.test(ua) ? "curl"
    : null;
  const os =
    /iPhone|iPad/.test(ua) ? "iOS"
    : /Android/.test(ua) ? "Android"
    : /Windows/.test(ua) ? "Windows"
    : /Mac OS X|Macintosh/.test(ua) ? "macOS"
    : /Linux|X11/.test(ua) ? "Linux"
    : null;
  if (!browser && !os) return null;
  return [browser, os].filter(Boolean).join(" · ");
}
