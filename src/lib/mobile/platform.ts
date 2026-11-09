import type { PlatformAlert, TenantRow } from "@/lib/platform/overview";

/** A platform alert for the app; the console's own links stay in the console. */
export function alertView(a: PlatformAlert) {
  return { level: a.level, kind: a.kind, text: a.text, tenant: a.tenant ? { id: a.tenant.id, slug: a.tenant.slug, name: a.tenant.name } : null };
}

/** One workspace row for the app's tenant list. */
export function tenantView(t: TenantRow) {
  const s = t.stats;
  return {
    id: t.id,
    slug: t.slug,
    name: t.name,
    plan: t.plan,
    status: t.deletedAt ? "DELETED" : t.status,
    createdAt: t.createdAt.toISOString(),
    lastActivity: s?.lastActivity ? new Date(s.lastActivity).toISOString() : null,
    stats: s ? {
      users: s.users, vendors: s.vendors, sites: s.sites,
      connectors: s.connectors, connectorsOnline: s.connectorsOnline,
      sessions24h: s.sessions24h, requestsPending: s.requestsPending,
    } : null,
    problems: t.problems,
  };
}
