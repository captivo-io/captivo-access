import { db } from "@/lib/db";
import { listActiveSessions, listActiveWebSessions } from "@/lib/dataplane/client";

export type LiveRow =
  | { kind: "gateway"; sessionId: string; siteName: string; userLabel: string; protocol: string; startedAt: string; viewerCount: number; controlled: boolean; grantId: string | null }
  | { kind: "isolated"; sessionId: string; siteName: string; userLabel: string; host: string; startedAt: string; viewerCount: number; grantId: string | null }
  | { kind: "web"; siteName: string; userLabel: string; host: string; startedAt: string; grantId: string | null };

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
    siteIds.length ? db.site.findMany({ where: { id: { in: siteIds } }, select: { id: true, name: true } }) : Promise.resolve([]),
    userIds.length
      ? db.accessGrant.findMany({
          where: { status: "ACTIVE", userId: { in: userIds }, siteId: { in: siteIds } },
          select: { id: true, userId: true, siteId: true },
        })
      : Promise.resolve([]),
  ]);
  const users = new Map(userList.map((u) => [u.id, u]));
  const sites = new Map(siteList.map((s) => [s.id, s]));
  const grantMap = new Map(liveGrants.map((g) => [g.userId + "\x1f" + g.siteId, g.id]));
  const label = (userId: string) => users.get(userId)?.name ?? users.get(userId)?.email ?? userId;
  const grant = (userId: string, siteId: string) => grantMap.get(userId + "\x1f" + siteId) ?? null;

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
  }));
  const webRows: LiveRow[] = webSessions.map((s) => ({
    kind: "web" as const,
    siteName: sites.get(s.siteId)?.name ?? s.host,
    userLabel: label(s.userId),
    host: s.host,
    startedAt: s.startedAt,
    grantId: grant(s.userId, s.siteId),
  }));
  return [...gatewayRows, ...isolatedRows, ...webRows];
}
