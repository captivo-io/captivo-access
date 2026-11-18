// The connector page's Activity tab: the newest access decisions on its
// resources, with identical requests (same person, resource, method, path and
// decision within the same minute) folded into one row with a count.

export interface ActivityEvent {
  id: string; at: string; user: string; siteId: string | null; siteName: string;
  method: string; path: string; allow: boolean;
}
export interface ActivityRow extends ActivityEvent { count: number }

export function mergeActivity(events: ActivityEvent[], limit = 50): ActivityRow[] {
  const byKey = new Map<string, ActivityRow>();
  const out: ActivityRow[] = [];
  for (const e of events) {
    const key = [e.user, e.siteId ?? e.siteName, e.method, e.path, e.allow ? 1 : 0, e.at.slice(0, 16)].join("\u0000");
    const row = byKey.get(key);
    if (row) { row.count++; continue; }
    if (out.length >= limit) continue;
    const r = { ...e, count: 1 };
    byKey.set(key, r);
    out.push(r);
  }
  return out;
}
