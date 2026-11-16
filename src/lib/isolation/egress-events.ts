import { db } from "@/lib/db";

// What an isolated resource's network rule blocked (or, report-only, would
// have) lately: the data-plane writes one audit event per destination per
// session ("egress_blocked <why> x<n>" / "egress_would_block ..."), grouped here
// by destination for the resource page.
export async function recentEgressEvents(siteId: string, days = 30) {
  const rows = await db.auditEvent.findMany({
    where: { siteId, reason: { startsWith: "egress_" }, timestamp: { gte: new Date(Date.now() - days * 86_400_000) } },
    select: { host: true, reason: true, timestamp: true },
    orderBy: { timestamp: "desc" },
    take: 2000,
  });
  const by = new Map<string, { dest: string; blocked: boolean; reason: string; count: number; last: string }>();
  for (const r of rows) {
    const m = /^egress_(blocked|would_block) (.*) x(\d+)$/.exec(r.reason ?? "");
    if (!m) continue;
    const e = by.get(r.host);
    if (e) {
      e.count += Number(m[3]);
      continue;
    }
    by.set(r.host, { dest: r.host, blocked: m[1] === "blocked", reason: m[2], count: Number(m[3]), last: r.timestamp.toISOString() });
  }
  return [...by.values()].sort((a, b) => b.count - a.count).slice(0, 50);
}
