import { db } from "@/lib/db";
import { listActiveSessions, listActiveWebSessions } from "@/lib/dataplane/client";
import { countPendingGrants, listPendingGrants } from "@/lib/access/grants";
import { getActivityFeed, type ActivityItem } from "@/lib/console/activity-feed";
import { recordingEnabled } from "@/lib/recording/enabled";
import { effectiveRecordSessions } from "@/lib/recording/mode";
import { resolvedRecordingMode } from "@/lib/settings/platform";
import { managerVersion } from "@/lib/version";
import { isConnectorOutdated } from "@/lib/updates/semver";

export type ConsoleAuditRow = ActivityItem;

export interface ConsoleKpis {
  grants: number;
  /** Grants created in the last 7 days that are still active. */
  grantsThisWeek: number;
  live: number;
  /** When the longest-running live session started, if any. */
  longestLiveSince: string | null;
  pending: number;
  expiring24h: number;
  recordings7d: number;
  /** Sessions opened in the last 7 days, to say what share was recorded. */
  sessions7d: number;
}
export type LiveCard =
  | { kind: "gateway"; sessionId: string; protocol: string; host: string; siteName: string; userLabel: string; startedAt: string; recorded: boolean; viewerCount: number; grantId: string | null }
  | { kind: "isolated"; sessionId: string; host: string; siteName: string; userLabel: string; startedAt: string; recorded: boolean; viewerCount: number; grantId: string | null }
  | { kind: "web"; userLabel: string; siteName: string; host: string; startedAt: string; lastSeen: string; grantId: string | null; liveKey: string | null; viewerCount: number };
export interface PendingCard { id: string; userLabel: string; siteName: string; detail: string }
export interface ExpiringRow { id: string; userLabel: string; siteName: string; endsAt: string }
export interface ConnectorRow { id: string; name: string; online: boolean; version: string | null; lastSeenAt: string | null; outdated: boolean }
export interface ConsoleData {
  kpis: ConsoleKpis;
  live: LiveCard[];
  pending: PendingCard[];
  expiring: ExpiringRow[];
  connectors: ConnectorRow[];
  audit: ConsoleAuditRow[];
  /** This console's version: what an outdated connector should run. */
  managerVersion: string;
}

// Read-only snapshot for the security console home. Reuses existing helpers;
// listActiveSessions() already fails soft to [] when the data-plane is down.
export async function getConsoleData(): Promise<ConsoleData> {
  const now = new Date();
  const in24h = new Date(now.getTime() + 24 * 3600 * 1000);
  const weekAgo = new Date(now.getTime() - 7 * 24 * 3600 * 1000);
  const recEnabled = recordingEnabled();
  // Resolve the tenant recording policy once (this snapshot is a single tenant) so the
  // live "REC" dot reflects what is actually recorded under required/off, not the raw
  // per-resource toggle. recEnabled is applied alongside below (see effectiveSiteRecording).
  const recMode = await resolvedRecordingMode();

  const [grants, grantsThisWeek, sessions7d, pending, expiring24h, recordings7d, sessions, webSessions, pendingRows, expiringRows, connectors, audit] = await Promise.all([
    db.accessGrant.count({ where: { status: "ACTIVE" } }),
    db.accessGrant.count({ where: { status: "ACTIVE", createdAt: { gte: weekAgo } } }),
    db.auditEvent.count({ where: { timestamp: { gte: weekAgo }, reason: { startsWith: "session_open" } } }),
    countPendingGrants(),
    db.accessGrant.count({ where: { status: "ACTIVE", endsAt: { gt: now, lte: in24h } } }),
    db.sessionRecording.count({ where: { startedAt: { gte: weekAgo } } }),
    listActiveSessions(),
    listActiveWebSessions(),
    listPendingGrants(),
    db.accessGrant.findMany({
      where: { status: "ACTIVE", endsAt: { gt: now, lte: in24h } },
      orderBy: { endsAt: "asc" }, take: 6,
      select: { id: true, endsAt: true, user: { select: { name: true, email: true } }, site: { select: { name: true } } },
    }),
    db.connector.findMany({ where: { status: { not: "REVOKED" } }, orderBy: { name: "asc" }, select: { id: true, name: true, status: true, version: true, lastSeenAt: true } }),
    getActivityFeed(12),
  ]);

  const webUserIds = webSessions.map((s) => s.userId);
  const webSiteIds = webSessions.map((s) => s.siteId);
  const userIds = [...new Set([...sessions.map((s) => s.userId), ...webUserIds])];
  const siteIds = [...new Set([...sessions.map((s) => s.siteId), ...webSiteIds])];

  const [users, sites, liveGrants] = await Promise.all([
    userIds.length ? db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, email: true } }) : Promise.resolve([]),
    siteIds.length ? db.site.findMany({ where: { id: { in: siteIds } }, select: { id: true, name: true, recordSessions: true } }) : Promise.resolve([]),
    userIds.length
      ? db.accessGrant.findMany({
          where: { status: "ACTIVE", userId: { in: userIds }, siteId: { in: siteIds } },
          select: { id: true, userId: true, siteId: true },
        })
      : Promise.resolve([]),
  ]);
  const userMap = new Map(users.map((u) => [u.id, u.name || u.email]));
  const siteNameMap = new Map(sites.map((s) => [s.id, s.name]));
  const recMap = new Map(sites.map((s) => [s.id, effectiveRecordSessions(recMode, s.recordSessions)]));
  const grantMap = new Map(liveGrants.map((g) => [g.userId + "\x1f" + g.siteId, g.id]));

  const gatewayCards: LiveCard[] = sessions.filter((s) => s.kind !== "isolated").map((s) => ({
    kind: "gateway" as const,
    sessionId: s.sessionId, protocol: s.protocol, host: s.host, siteName: siteNameMap.get(s.siteId) ?? s.host,
    userLabel: userMap.get(s.userId) ?? "unknown", startedAt: s.startedAt,
    recorded: recEnabled && (recMap.get(s.siteId) ?? false), viewerCount: s.viewerCount,
    grantId: grantMap.get(s.userId + "\x1f" + s.siteId) ?? null,
  }));
  const isolatedCards: LiveCard[] = sessions.filter((s) => s.kind === "isolated").map((s) => ({
    kind: "isolated" as const,
    sessionId: s.sessionId, host: s.host, siteName: siteNameMap.get(s.siteId) ?? s.host,
    userLabel: userMap.get(s.userId) ?? "unknown", startedAt: s.startedAt,
    recorded: recEnabled && (recMap.get(s.siteId) ?? false), viewerCount: s.viewerCount,
    grantId: grantMap.get(s.userId + "\x1f" + s.siteId) ?? null,
  }));
  const webCards: LiveCard[] = webSessions.map((s) => ({
    kind: "web" as const,
    userLabel: userMap.get(s.userId) ?? "unknown",
    siteName: siteNameMap.get(s.siteId) ?? s.host,
    host: s.host, startedAt: s.startedAt, lastSeen: s.lastSeen,
    grantId: grantMap.get(s.userId + "\x1f" + s.siteId) ?? null,
    liveKey: s.liveKey || null, viewerCount: s.viewers ?? 0,
  }));
  const live: LiveCard[] = [...gatewayCards, ...isolatedCards, ...webCards];

  const starts = live.map((c) => c.startedAt).filter(Boolean).sort();
  const mgr = managerVersion();
  return {
    kpis: {
      grants, grantsThisWeek, live: sessions.length + webSessions.length, longestLiveSince: starts[0] ?? null,
      pending, expiring24h, recordings7d, sessions7d,
    },
    live,
    pending: pendingRows.map((p) => ({ id: p.id, userLabel: p.user.name || p.user.email, siteName: p.site.name, detail: p.note ?? "" })),
    expiring: expiringRows.map((e) => ({ id: e.id, userLabel: e.user.name || e.user.email, siteName: e.site.name, endsAt: (e.endsAt as Date).toISOString() })),
    connectors: connectors.map((c) => ({
      id: c.id, name: c.name, online: c.status === "ONLINE", version: c.version,
      lastSeenAt: c.lastSeenAt ? c.lastSeenAt.toISOString() : null,
      outdated: !!c.version && isConnectorOutdated(c.version, mgr),
    })),
    audit,
    managerVersion: mgr,
  };
}
