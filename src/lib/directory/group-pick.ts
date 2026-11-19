import { cnOf, normalizeDN } from "@/lib/directory/reconcile";

// Helpers for the Group mappings picker: where a found group lives, and whether
// a mapping already names it (by full DN, or by the bare name an admin typed).

/** "CN=DB-Ops,OU=Groups,DC=corp,DC=local" -> "OU=Groups,DC=corp,DC=local". */
export function parentOf(dn: string): string {
  const i = dn.indexOf(",");
  return i >= 0 ? dn.slice(i + 1).trim() : "";
}

/** True when some mapping already names this group. */
export function isMapped(groupDN: string, mapped: string[]): boolean {
  const dn = normalizeDN(groupDN);
  const cn = cnOf(groupDN);
  return mapped.some((m) => {
    const v = m.trim();
    return v.includes("=") || v.includes(",") ? normalizeDN(v) === dn : v.toLowerCase() === cn;
  });
}

/** Mappings whose group or target contains the filter text. */
export function filterMappings<T extends { groupDN: string; target: string }>(rows: T[], q: string): T[] {
  const t = q.trim().toLowerCase();
  if (!t) return rows;
  return rows.filter((r) => r.groupDN.toLowerCase().includes(t) || r.target.toLowerCase().includes(t));
}
