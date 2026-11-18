import { BlockList, isIP } from "node:net";

// IP allowlist matching backed by Node's built-in net.BlockList (correct IPv4
// and IPv6 CIDR handling, no hand-rolled bit math). Entries are CIDRs
// (10.0.0.0/8, 2001:db8::/32) or bare IPs, separated by commas/whitespace.

function entriesOf(raw: string): string[] {
  return raw.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
}

// addEntry adds one CIDR/IP to bl, returning false (without throwing) if it's
// malformed or the prefix is out of range — so enforcement never crashes on a
// bad stored value and validation can report exactly which entries are invalid.
function addEntry(bl: BlockList, entry: string): boolean {
  try {
    const slash = entry.indexOf("/");
    if (slash >= 0) {
      const addr = entry.slice(0, slash);
      const rawPrefix = entry.slice(slash + 1);
      // Digits only: Number("") is 0, so "1.2.3.4/" would otherwise allow everyone.
      if (!/^\d{1,3}$/.test(rawPrefix)) return false;
      const prefix = Number(rawPrefix);
      const fam = isIP(addr);
      if (!fam) return false;
      bl.addSubnet(addr, prefix, fam === 4 ? "ipv4" : "ipv6");
      return true;
    }
    const fam = isIP(entry);
    if (!fam) return false;
    bl.addAddress(entry, fam === 4 ? "ipv4" : "ipv6");
    return true;
  } catch {
    return false;
  }
}

// validateAllowlist returns the list of invalid entries (empty = all valid).
// Used at save time so a bad entry is rejected before it's stored.
export function validateAllowlist(raw: string): string[] {
  const bl = new BlockList();
  return entriesOf(raw).filter((e) => !addEntry(bl, e));
}

let cached: { raw: string; bl: BlockList | null } | null = null;

function build(raw: string): BlockList | null {
  const entries = entriesOf(raw);
  if (entries.length === 0) return null;
  const bl = new BlockList();
  let any = false;
  for (const e of entries) if (addEntry(bl, e)) any = true;
  return any ? bl : null; // all-invalid list behaves as no list rather than locking everyone out
}

// normalizeIp maps an IPv4-mapped IPv6 address (::ffff:1.2.3.4) to plain IPv4
// so it matches IPv4 rules in the allowlist.
function normalizeIp(ip: string): string {
  const m = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  return m ? m[1] : ip;
}

// ipAllowed reports whether ip is permitted by the raw allowlist. An empty (or
// all-invalid) list means no restriction → true. Under an active list, an
// unparseable client IP is denied (fail closed). The compiled BlockList is
// cached by its raw string so this is cheap on the per-request access path.
export function ipAllowed(raw: string, ip: string): boolean {
  if (!cached || cached.raw !== raw) cached = { raw, bl: build(raw) };
  if (cached.bl === null) return true;
  const norm = normalizeIp(ip);
  const fam = isIP(norm);
  if (!fam) return false;
  return cached.bl.check(norm, fam === 4 ? "ipv4" : "ipv6");
}
