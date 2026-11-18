import { db } from "@/lib/db";
import { parseSchedule, compactDays, nextScheduleStart } from "@/lib/access/schedule";
import { grantKind, grantState, isPermanent, endsSoon, type GrantKind, type GrantState } from "@/lib/access/grant-view";
import type { DecisionReason } from "@/lib/access/classify";

/** What a resource tile shows: WEB/HTTPS/RDP/SSH…, and the address it points at. */
export interface SiteTile { id: string; name: string; proto: string; remote: boolean; host: string | null }

type SiteFacts = {
  id: string; name: string; accessMode: string; upstreamUrl: string | null;
  vaultCredential: { targetHost: string; targetPort: number | null; protocol: string } | null;
};

export function siteTile(s: SiteFacts): SiteTile {
  const remote = s.accessMode === "GATEWAY";
  if (remote) {
    const v = s.vaultCredential;
    return { id: s.id, name: s.name, remote, proto: v ? String(v.protocol).toUpperCase() : "REMOTE", host: v ? (v.targetPort ? `${v.targetHost}:${v.targetPort}` : v.targetHost) : null };
  }
  const u = s.upstreamUrl ?? "";
  return { id: s.id, name: s.name, remote, proto: u.startsWith("http://") ? "HTTP" : "HTTPS", host: u ? u.replace(/^[a-z]+:\/\//i, "").replace(/\/$/, "") : null };
}

export const SITE_TILE_SELECT = {
  id: true, name: true, accessMode: true, upstreamUrl: true,
  vaultCredential: { select: { targetHost: true, targetPort: true, protocol: true } },
} as const;

export interface GrantRowJSON {
  id: string;
  userId: string;
  siteId: string;
  kind: GrantKind;
  state: GrantState;
  reason: DecisionReason;
  startsAt: string | null;
  endsAt: string | null;
  createdAt: string;
  /** When it stopped: its end (expired), the revoke (from the admin log) or the decision (denied). */
  endedAt: string | null;
  /** Recurring hours: "Mon–Fri", "09:00–18:00", the zone, and the next opening. */
  days: string | null;
  hours: string | null;
  zone: string | null;
  nextStart: string | null;
  note: string | null;
  denyReason: string | null;
  permanent: boolean;
  soon: boolean;
}

/** Every grant (pending requests aside) as the Grants page and its CSV show them. */
export async function grantRows(now: Date): Promise<GrantRowJSON[]> {
  const grants = await db.accessGrant.findMany({
    orderBy: { createdAt: "desc" },
    select: {
      id: true, userId: true, siteId: true, startsAt: true, endsAt: true, status: true, requiresApproval: true,
      approvedAt: true, schedule: true, note: true, denyReason: true, createdAt: true,
    },
  });
  const revokedIds = grants.filter((g) => g.status === "REVOKED").map((g) => g.id);
  const revokes = revokedIds.length
    ? await db.adminAuditEvent.findMany({
        where: { action: "grant.revoke", targetId: { in: revokedIds } },
        select: { targetId: true, timestamp: true },
      })
    : [];
  const revokedAt = new Map(revokes.map((r) => [r.targetId, r.timestamp]));

  const rows: GrantRowJSON[] = [];
  for (const g of grants) {
    const { state, reason } = grantState(g, now);
    if (state === "pending") continue;
    const s = parseSchedule(g.schedule);
    const endedAt =
      state !== "ended" ? null
        : g.status === "REVOKED" ? revokedAt.get(g.id) ?? null
          : g.status === "DENIED" ? g.approvedAt
            : g.endsAt;
    rows.push({
      id: g.id,
      userId: g.userId,
      siteId: g.siteId,
      kind: grantKind(g),
      state,
      reason,
      startsAt: g.startsAt?.toISOString() ?? null,
      endsAt: g.endsAt?.toISOString() ?? null,
      createdAt: g.createdAt.toISOString(),
      endedAt: endedAt?.toISOString() ?? null,
      days: s ? compactDays(s.days) : null,
      hours: s ? `${s.start}–${s.end}` : null,
      zone: s?.timezone ?? null,
      nextStart: s && state !== "ended" ? nextScheduleStart(s, now)?.toISOString() ?? null : null,
      note: g.note,
      denyReason: g.denyReason,
      permanent: isPermanent(g, state),
      soon: endsSoon(g, state, now),
    });
  }
  return rows;
}
