// The isolated browser's network rule for one resource. The browser runs with
// no network of its own; the connector's egress proxy (connector/egress.go)
// applies this rule to every request of the session:
//
//   internet  the resource and the public internet (sign-in pages, CDNs), but
//             no other machine on the internal network (the default)
//   strict    only the resource and the hosts listed here
//   open      anything (a deliberate choice)
//
// A resource either picks one or inherits the Policy default (Site.egressMode
// null; PlatformSettings.isolatedEgressDefault, "internet" when unset).
//
// Listed hosts ("intranet.local", "*.okta.com") are allowed in every mode,
// internal or not. Never allowed in any mode: the connector host itself and
// cloud metadata addresses.

export const EGRESS_MODES = ["internet", "strict", "open"] as const;
export type EgressMode = (typeof EGRESS_MODES)[number];
export const DEFAULT_EGRESS_MODE: EgressMode = "internet";
export const MAX_EGRESS_HOSTS = 50;

// Isolated resources that existed before the rule shipped start in report-only:
// what it would block is recorded, nothing is blocked, until this date or until
// an admin picks a mode for the resource (inheriting is not picking).
export const EGRESS_SHIPPED_AT = new Date("2026-11-17T00:00:00Z");
export const EGRESS_REPORT_ONLY_UNTIL = new Date("2026-12-01T00:00:00Z");

const HOST_RE = /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

export function isEgressMode(v: unknown): v is EgressMode {
  return typeof v === "string" && (EGRESS_MODES as readonly string[]).includes(v);
}

// Hosts as an admin types them: one per line or comma-separated, a pasted URL
// reduced to its host. Returns null when one is not a host name or address.
export function parseEgressHosts(v: unknown): string[] | null {
  const raw = Array.isArray(v) ? v.map(String) : typeof v === "string" ? v.split(/[\s,]+/) : [];
  const out: string[] = [];
  for (let h of raw) {
    h = h.trim().toLowerCase();
    if (!h) continue;
    if (/^[a-z]+:\/\//.test(h)) {
      try {
        h = new URL(h).hostname;
      } catch {
        return null;
      }
    }
    h = h.replace(/\.$/, "").replace(/^\[(.*)\]$/, "$1");
    const ip = /^[0-9.]+$/.test(h) || h.includes(":");
    if (!ip && !HOST_RE.test(h)) return null;
    if (!out.includes(h)) out.push(h);
  }
  return out.length > MAX_EGRESS_HOSTS ? null : out;
}

export type SiteEgress = { egressMode: string | null; egressHosts: string[]; createdAt: Date; upstreamUrl: string | null };

export function egressReportOnlyUntil(s: SiteEgress, now = new Date()): Date | null {
  if (s.egressMode !== null || s.createdAt >= EGRESS_SHIPPED_AT || now >= EGRESS_REPORT_ONLY_UNTIL) return null;
  return EGRESS_REPORT_ONLY_UNTIL;
}

// What the data-plane hands the connector for one session. policyDefault is
// the Policy's mode for resources that inherit.
export function effectiveEgress(s: SiteEgress, now = new Date(), policyDefault: EgressMode = DEFAULT_EGRESS_MODE): { mode: EgressMode; hosts: string[]; reportOnly: boolean } {
  const hosts = [...s.egressHosts];
  try {
    const own = s.upstreamUrl ? new URL(s.upstreamUrl).hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1") : "";
    if (own && !hosts.includes(own)) hosts.unshift(own);
  } catch {
    /* an invalid upstream never opens a session anyway */
  }
  return {
    mode: isEgressMode(s.egressMode) ? s.egressMode : policyDefault,
    hosts,
    reportOnly: egressReportOnlyUntil(s, now) !== null,
  };
}
