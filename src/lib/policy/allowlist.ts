// The vendor IP allowlist as the Policy page checks it while typing: each entry
// is an IPv4 or IPv6 address, optionally with a /prefix. Browser-safe (no
// node:net); the server's lib/net/cidr.ts stays the authority on save and must
// agree with this (see allowlist.test.ts).

export function allowlistEntries(raw: string): string[] {
  return raw.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
}

function ipv4(s: string): boolean {
  const parts = s.split(".");
  return parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255 && !(p.length > 1 && p.startsWith("0")));
}

function ipv6(s: string): boolean {
  if (!/^[0-9a-fA-F:.]+$/.test(s) || s.includes(":::")) return false;
  let groups = s.split(":");
  // An IPv4 tail (::ffff:1.2.3.4) counts as two groups.
  const last = groups[groups.length - 1];
  let extra = 0;
  if (last.includes(".")) {
    if (!ipv4(last)) return false;
    groups = groups.slice(0, -1);
    extra = 2;
  }
  const compressed = s.includes("::");
  if (compressed && s.indexOf("::") !== s.lastIndexOf("::")) return false;
  const filled = groups.filter((g, i) => !(g === "" && (compressed || i === 0 || i === groups.length - 1)));
  if (!filled.every((g) => /^[0-9a-fA-F]{1,4}$/.test(g))) return false;
  const count = filled.length + extra;
  if (compressed) return count < 8;
  // Without "::" there are no empty groups at all.
  return count === 8 && !groups.includes("");
}

/** One entry: an address or address/prefix (IPv4 /0–32, IPv6 /0–128). */
export function allowlistEntryValid(entry: string): boolean {
  const slash = entry.indexOf("/");
  const addr = slash >= 0 ? entry.slice(0, slash) : entry;
  const prefix = slash >= 0 ? entry.slice(slash + 1) : null;
  const fam = ipv4(addr) ? 4 : ipv6(addr) ? 6 : 0;
  if (!fam) return false;
  if (prefix === null) return true;
  if (!/^\d{1,3}$/.test(prefix)) return false;
  return Number(prefix) <= (fam === 4 ? 32 : 128);
}

export function checkAllowlist(raw: string): { entries: { text: string; ok: boolean }[]; invalid: string[] } {
  const entries = allowlistEntries(raw).map((text) => ({ text, ok: allowlistEntryValid(text) }));
  return { entries, invalid: entries.filter((e) => !e.ok).map((e) => e.text) };
}
