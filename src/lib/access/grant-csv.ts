import type { GrantRowJSON, SiteTile } from "@/lib/access/grant-rows";

const STATE: Record<GrantRowJSON["state"], string> = { active: "active", scheduled: "scheduled", ended: "ended", pending: "pending" };

/** The Grants page as CSV, one line per grant. Pure so it unit-tests. */
export function grantsToCsv(
  rows: GrantRowJSON[],
  users: Map<string, { name: string; email: string; role: string }>,
  sites: Map<string, SiteTile>,
  esc: (v: string) => string,
): string {
  const head = ["user", "email", "role", "resource", "address", "kind", "status", "reason", "starts", "ends", "recurring", "ticket", "note", "created", "ended"];
  const lines = [head.join(",")];
  for (const r of rows) {
    const u = users.get(r.userId);
    const s = sites.get(r.siteId);
    lines.push([
      u?.name ?? "", u?.email ?? "", u?.role ?? "", s?.name ?? "", s?.host ?? "",
      r.kind, STATE[r.state], r.reason, r.startsAt ?? "", r.endsAt ?? "",
      r.days ? `${r.days} ${r.hours} (${r.zone})` : "", r.ticketRef ?? "", r.note ?? "", r.createdAt, r.endedAt ?? "",
    ].map((v) => esc(v)).join(","));
  }
  return lines.join("\n") + "\n";
}
