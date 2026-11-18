import { db } from "@/lib/db";
import { countPendingGrants } from "@/lib/access/grants";
import { countUnreadNotifications } from "@/lib/notifications";

export function healthTone(reachable: number, total: number): "ok" | "warn" | "danger" | "neutral" {
  if (total === 0) return "neutral";
  if (reachable === total) return "ok";
  if (reachable === 0) return "danger";
  return "warn";
}

export function siteStatePill(probeOk: boolean | null): {
  label: "Reachable" | "Down" | "Unknown";
  tone: "ok" | "danger" | "neutral";
} {
  if (probeOk === true) return { label: "Reachable", tone: "ok" };
  if (probeOk === false) return { label: "Down", tone: "danger" };
  return { label: "Unknown", tone: "neutral" };
}

export type DashboardStats = {
  connectors: number;
  connectorsOnline: number;
  sites: number;
  sitesReachable: number;
  sitesDown: number;
  sitesUnknown: number;
  activeGrants: number;
  pending: number;
  unreadAlerts: number;
};

export async function getDashboardStats(): Promise<DashboardStats> {
  const [connectors, connectorsOnline, sites, sitesReachable, sitesDown, activeGrants, pending, unreadAlerts] =
    await Promise.all([
      db.connector.count(),
      db.connector.count({ where: { status: "ONLINE" } }),
      db.site.count(),
      db.site.count({ where: { probeOk: true } }),
      db.site.count({ where: { probeOk: false } }),
      db.accessGrant.count({ where: { status: "ACTIVE" } }),
      countPendingGrants(),
      countUnreadNotifications(),
    ]);
  return {
    connectors,
    connectorsOnline,
    sites,
    sitesReachable,
    sitesDown,
    sitesUnknown: sites - sitesReachable - sitesDown,
    activeGrants,
    pending,
    unreadAlerts,
  };
}

export type SiteHealthRow = {
  id: string;
  name: string;
  probeOk: boolean | null;
  probeLatencyMs: number | null;
  probedAt: Date | null;
};

export async function getSiteHealth(): Promise<SiteHealthRow[]> {
  return db.site.findMany({
    orderBy: { name: "asc" },
    select: { id: true, name: true, probeOk: true, probeLatencyMs: true, probedAt: true },
  });
}

export type ActivityRow = {
  id: string;
  decision: "ALLOW" | "DENY";
  userEmail: string | null;
  siteName: string | null;
  host: string;
  path: string;
  timestamp: Date;
};

export async function getRecentActivity(limit = 8): Promise<ActivityRow[]> {
  return db.auditEvent.findMany({
    orderBy: { timestamp: "desc" },
    take: limit,
    select: { id: true, decision: true, userEmail: true, siteName: true, host: true, path: true, timestamp: true },
  });
}
