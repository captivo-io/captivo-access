import { db } from "@/lib/db";
import { listActiveSessions, listActiveWebSessions } from "@/lib/dataplane/client";
import { siteTile, SITE_TILE_SELECT, type SiteTile } from "@/lib/access/grant-rows";

/** What the console's Sessions page adds to every row; optional so older readers (the app) are unaffected. */
export interface LiveExtra {
  userId?: string;
  siteId?: string;
  userEmail?: string | null;
  /** From the data plane (gateway and isolated); absent for web apps. */
  clientIp?: string | null;
  recording?: boolean;
  keystrokes?: boolean;
  activity?: number[];
  /** The grant the session runs under: no end, an end time, or set hours. */
  grantEndsAt?: string | null;
  grantScheduled?: boolean;
  /** The resource's tile (icon or logo). */
  site?: SiteTile;
  /** A native RDP client on the RD Gateway: it can be ended, not watched. */
  native?: boolean;
  /** A connector-group resource: the member carrying this session. */
  via?: string | null;
}

export type LiveRow =
  | ({ kind: "gateway"; sessionId: string; siteName: string; userLabel: string; protocol: string; startedAt: string; viewerCount: number; controlled: boolean; grantId: string | null } & LiveExtra)
  | ({ kind: "isolated"; sessionId: string; siteName: string; userLabel: string; host: string; startedAt: string; viewerCount: number; grantId: string | null } & LiveExtra)
  | ({ kind: "web"; siteName: string; userLabel: string; host: string; startedAt: string; grantId: string | null; liveKey: string | null; viewerCount: number } & LiveExtra);

/**
 * The workspace's live sessions, labelled for people: who, on which site, and
 * the grant a terminate can revoke. The console's live page and the app both
 * read this, so they never disagree about what is running.
 */
export async function liveRows(): Promise<LiveRow[]> {
  const [sessions, webSessions] = await Promise.all([listActiveSessions(), listActiveWebSessions()]);
  const userIds = [...new Set([...sessions.map((s) => s.userId), ...webSessions.map((s) => s.userId)])];
  const siteIds = [...new Set([...sessions.map((s) => s.siteId), ...webSessions.map((s) => s.siteId)])];

  const [userList, siteList, liveGrants] = await Promise.all([
    userIds.length ? db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, email: true } }) : Promise.resolve([]),
    siteIds.length ? db.site.findMany({ where: { id: { in: siteIds } }, select: { ...SITE_TILE_SELECT, connectorGroupId: true } }) : Promise.resolve([]),
    userIds.length
      ? db.accessGrant.findMany({
          where: { status: "ACTIVE", userId: { in: userIds }, siteId: { in: siteIds } },
          select: { id: true, userId: true, siteId: true, endsAt: true, schedule: true },
        })
      : Promise.resolve([]),
  ]);
  const users = new Map(userList.map((u) => [u.id, u]));
  // On a group resource, which member carries each session.
  const carrierIds = [...new Set(sessions.filter((s) => s.connectorId && siteList.some((x) => x.id === s.siteId && x.connectorGroupId)).map((s) => s.connectorId!))];
  const carriers = new Map((carrierIds.length ? await db.connector.findMany({ where: { id: { in: carrierIds } }, select: { id: true, name: true } }) : []).map((c) => [c.id, c.name]));
  const via = (s: { connectorId?: string }) => (s.connectorId ? carriers.get(s.connectorId) ?? null : null);
  const sites = new Map(siteList.map((s) => [s.id, s]));
  const grantMap = new Map(liveGrants.map((g) => [g.userId + "\x1f" + g.siteId, g]));
  const label = (userId: string) => users.get(userId)?.name ?? users.get(userId)?.email ?? userId;
  const grantOf = (userId: string, siteId: string) => grantMap.get(userId + "\x1f" + siteId) ?? null;
  const grant = (userId: string, siteId: string) => grantOf(userId, siteId)?.id ?? null;
  const extra = (userId: string, siteId: string): LiveExtra => {
    const g = grantOf(userId, siteId);
    return {
      userId, siteId,
      userEmail: users.get(userId)?.email ?? null,
      grantEndsAt: g?.endsAt?.toISOString() ?? null,
      grantScheduled: g?.schedule != null,
      site: sites.has(siteId) ? siteTile(sites.get(siteId)!) : undefined,
    };
  };

  const gatewayRows: LiveRow[] = sessions.filter((s) => s.kind !== "isolated").map((s) => ({
    kind: "gateway" as const,
    sessionId: s.sessionId,
    siteName: sites.get(s.siteId)?.name ?? s.host,
    userLabel: label(s.userId),
    protocol: s.protocol,
    startedAt: s.startedAt,
    viewerCount: s.viewerCount,
    controlled: s.controlOwner !== "",
    grantId: grant(s.userId, s.siteId),
    ...extra(s.userId, s.siteId),
    clientIp: s.clientIp || null, recording: s.recording, keystrokes: s.keystrokes, activity: s.activity,
    native: !!s.native,
    via: via(s),
  }));
  const isolatedRows: LiveRow[] = sessions.filter((s) => s.kind === "isolated").map((s) => ({
    kind: "isolated" as const,
    sessionId: s.sessionId,
    siteName: sites.get(s.siteId)?.name ?? s.host,
    userLabel: label(s.userId),
    host: s.host,
    startedAt: s.startedAt,
    viewerCount: s.viewerCount,
    grantId: grant(s.userId, s.siteId),
    ...extra(s.userId, s.siteId),
    clientIp: s.clientIp || null, recording: s.recording, keystrokes: s.keystrokes, activity: s.activity,
    via: via(s),
  }));
  const webRows: LiveRow[] = webSessions.map((s) => ({
    kind: "web" as const,
    siteName: sites.get(s.siteId)?.name ?? s.host,
    userLabel: label(s.userId),
    host: s.host,
    startedAt: s.startedAt,
    grantId: grant(s.userId, s.siteId),
    liveKey: s.liveKey || null,
    viewerCount: s.viewers ?? 0,
    ...extra(s.userId, s.siteId),
    // A web app tab is watchable exactly when its site records.
    recording: !!s.liveKey,
  }));
  return [...gatewayRows, ...isolatedRows, ...webRows];
}
