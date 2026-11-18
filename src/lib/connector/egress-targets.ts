// The connector's egress narrowing ("ALLOWED_TARGETS" pushed as policy). The
// connector parses it with ParseAllowedTargets (connector/config.go): entries
// split on commas, each a CIDR, a host:port or a bare host. A malformed CIDR
// makes the connector drop the whole update and keep the previous rule, and an
// entry it reads as a host that is no host (a typo, "*.corp", "10.0.0.300")
// matches nothing. So the console accepts only entries the connector reads
// the way the admin meant, and saves them comma-separated.

export type TargetKind = "cidr" | "hp" | "host" | "ip";
export interface Target { v: string; kind: TargetKind | null } // null = not valid

const V4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const HOST = /^(?=.{1,253}$)[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?(?:\.[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?)*\.?$/i;

function isV6(s: string): boolean {
  if (!s.includes(":") || !/^[0-9a-f:.]+$/i.test(s)) return false;
  try { new URL(`http://[${s}]/`); return true; } catch { return false; }
}
const isIp = (s: string) => V4.test(s) || isV6(s);
const isPort = (s: string) => /^\d{1,5}$/.test(s) && Number(s) >= 1 && Number(s) <= 65535;
// A name made only of digits and dots is a mistyped address, never a host.
const isHostName = (s: string) => HOST.test(s) && !/^[\d.]+$/.test(s);

export function classifyTarget(v: string): TargetKind | null {
  if (v.includes("/")) {
    const [ip, prefix, more] = v.split("/");
    if (more !== undefined || !/^\d{1,3}$/.test(prefix ?? "")) return null;
    const p = Number(prefix);
    if (V4.test(ip)) return p <= 32 ? "cidr" : null;
    if (isV6(ip)) return p <= 128 ? "cidr" : null;
    return null;
  }
  const br = /^\[([^\]]+)\]:(\d+)$/.exec(v);
  if (br) return isV6(br[1]) && isPort(br[2]) ? "hp" : null;
  if (isIp(v)) return "ip";
  const parts = v.split(":");
  if (parts.length === 2) return (V4.test(parts[0]) || isHostName(parts[0])) && isPort(parts[1]) ? "hp" : null;
  if (parts.length === 1) return isHostName(v) ? "host" : null;
  return null;
}

/** Entries may be separated by commas, spaces or new lines. */
export function parseTargets(text: string): { targets: Target[]; invalid: string[]; normalized: string } {
  const targets = text.split(/[\s,]+/).filter(Boolean).map((v) => ({ v, kind: classifyTarget(v) }));
  return {
    targets,
    invalid: targets.filter((t) => !t.kind).map((t) => t.v),
    normalized: targets.map((t) => t.v).join(", "),
  };
}
