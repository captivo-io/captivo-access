import type { Prisma } from "@/generated/prisma/client";
import type { ConnectorStatus } from "@/generated/prisma/enums";
import { compareSemver } from "@/lib/updates/semver";

// Which connectors may carry a resource's session. A resource on one connector
// has just that one, exactly as before groups. A resource on a connector group
// has every member that can serve it; the dataplane picks among them at the
// moment the session opens (dataplane/connpick.go), because only it knows
// which tunnels are up and how many sessions each carries.

export type RouteConnector = { id: string; name: string; status: ConnectorStatus; version: string | null; vaultPublicKey: string | null };
export type RouteMember = RouteConnector & { standby: boolean };

export type SiteRouting = {
  connectorId: string;
  connector: RouteConnector;
  connectorGroup: { id: string; name: string; members: { standby: boolean; connector: RouteConnector }[] } | null;
  probeByConnector: Prisma.JsonValue | null;
};

const connectorSelect = { id: true, name: true, status: true, version: true, vaultPublicKey: true } as const;

/** The Site fields routeMembers reads; spread into a Site select. */
export const siteRoutingSelect = {
  connectorId: true,
  connector: { select: connectorSelect },
  connectorGroup: { select: { id: true, name: true, members: { orderBy: { createdAt: "asc" }, select: { standby: true, connector: { select: connectorSelect } } } } },
  probeByConnector: true,
} as const satisfies Prisma.SiteSelect;

export type MemberProbe = { ok: boolean; ms: number | null; at: string; detail: string | null };

/** The health probe's per-member results for a group resource. */
export function memberProbes(v: Prisma.JsonValue | null | undefined): Record<string, MemberProbe> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out: Record<string, MemberProbe> = {};
  for (const [id, raw] of Object.entries(v)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const p = raw as Record<string, unknown>;
    if (typeof p.ok !== "boolean" || typeof p.at !== "string") continue;
    out[id] = { ok: p.ok, ms: typeof p.ms === "number" ? p.ms : null, at: p.at, detail: typeof p.detail === "string" ? p.detail : null };
  }
  return out;
}

export type Exclusion = "revoked" | "outdated" | "no_seal" | "unreachable";

export type RouteOptions = {
  /** Members older than this cannot carry the session (native RDP/SSH relays). */
  minVersion?: string;
  /** False for a member that cannot open the resource's sealed secret. */
  canOpen?: (m: RouteMember) => boolean;
};

/**
 * The members that may carry a group resource's sessions, active ones first,
 * and why the others may not. A member the health probe last saw fail to reach
 * the resource is left out while another member reaches it: it would only
 * hand some users an error. A resource on a single connector returns it, with
 * no filtering, so its behaviour is the one it always had.
 */
export function routeMembers(r: SiteRouting, opts: RouteOptions = {}): { eligible: RouteMember[]; excluded: { member: RouteMember; why: Exclusion }[] } {
  if (!r.connectorGroup) return { eligible: [{ ...r.connector, standby: false }], excluded: [] };
  const probes = memberProbes(r.probeByConnector);
  const members = r.connectorGroup.members.map((m) => ({ ...m.connector, standby: m.standby }));
  const someoneReaches = members.some((m) => m.status !== "REVOKED" && probes[m.id]?.ok === true);
  const eligible: RouteMember[] = [];
  const excluded: { member: RouteMember; why: Exclusion }[] = [];
  for (const m of members) {
    const why: Exclusion | null =
      m.status === "REVOKED" ? "revoked"
      : opts.minVersion && compareSemver(m.version, opts.minVersion) === -1 ? "outdated"
      : opts.canOpen && !opts.canOpen(m) ? "no_seal"
      : someoneReaches && probes[m.id]?.ok === false ? "unreachable"
      : null;
    if (why) excluded.push({ member: m, why });
    else eligible.push(m);
  }
  eligible.sort((a, b) => Number(a.standby) - Number(b.standby));
  return { eligible, excluded };
}

export type RouteCandidate = { id: string; standby?: true } & Record<string, unknown>;

/** What the dataplane is told: [{ id, standby }] in order of preference. */
export function candidatesFor(members: RouteMember[], extra?: (m: RouteMember) => Record<string, unknown>): RouteCandidate[] {
  return members.map((m) => ({ id: m.id, ...(m.standby ? { standby: true as const } : {}), ...(extra ? extra(m) : {}) }));
}

/** The highest version among members: a group can relay what its newest member can. */
export function newestVersion(r: SiteRouting): string | null {
  if (!r.connectorGroup) return r.connector.version;
  let best: string | null = null;
  for (const m of r.connectorGroup.members) {
    if (m.connector.status === "REVOKED") continue;
    // A non-semver build ("dev") counts as new, as the native checks treat it.
    if (best === null || (m.connector.version && compareSemver(m.connector.version, best) !== -1)) best = m.connector.version;
  }
  return best;
}
