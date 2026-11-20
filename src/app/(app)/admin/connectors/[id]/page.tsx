import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/current-user";
import { db } from "@/lib/db";
import { managerVersion } from "@/lib/version";
import { isConnectorOutdated } from "@/lib/updates/semver";
import { getConnectorTelemetry } from "@/lib/connector/telemetry";
import { resolvedDefaultConnectorLogLevel } from "@/lib/settings/platform";
import { buildConnectorUpdateCommand } from "@/lib/connector/repair";
import { storedHostAction } from "@/lib/connector/host-action";
import { connectorTunnelUrl, isLocalManagerUrl } from "@/lib/url";
import { siteTile, SITE_TILE_SELECT } from "@/lib/access/grant-rows";
import { mergeActivity } from "@/lib/connector/activity";
import { withRequestTenant } from "@/lib/tenant/request";
import { SLOW_SCOPE_BUDGET_MS } from "@/lib/tenant/scope";
import { ConnectorDetail } from "./connector-detail";
import { TABS, type Tab } from "./tabs";
import { workspaceView } from "@/lib/mobile/views";

export const dynamic = "force-dynamic";
export const metadata = { title: "Connector" };

/**
 * One connector, as design hand-off 7.23 lays it out: a header with its state,
 * then Overview / Resources / Logs / Activity / Settings tabs (?tab=…). The
 * live counters and log tails come from the data-plane; the page polls them.
 */
async function ConnectorDetailPageImpl({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ tab?: string | string[] }> }) {
  await requireAdmin();
  const [{ id }, sp] = await Promise.all([params, searchParams]);

  const connector = await db.connector.findUnique({
    where: { id },
    select: {
      id: true, name: true, status: true, version: true, lastSeenAt: true, remoteAddr: true, createdAt: true,
      egressPolicy: true, logLevel: true, hostAction: true,
      sites: {
        select: { ...SITE_TILE_SELECT, hostname: true, probeOk: true, probeLatencyMs: true, probeDetail: true, probedAt: true },
        orderBy: { name: "asc" },
      },
    },
  });
  if (!connector) notFound();

  const siteIds = connector.sites.map((s) => s.id);
  const [tele, events, defaultLogLevel, ws] = await Promise.all([
    connector.status === "REVOKED" ? Promise.resolve({ online: false } as const) : getConnectorTelemetry(connector.id).catch(() => ({ online: false } as const)),
    siteIds.length
      ? db.auditEvent.findMany({
          where: { siteId: { in: siteIds } },
          orderBy: { timestamp: "desc" },
          take: 300,
          select: { id: true, timestamp: true, userEmail: true, userName: true, siteId: true, siteName: true, method: true, path: true, decision: true },
        })
      : Promise.resolve([]),
    resolvedDefaultConnectorLogLevel(),
    workspaceView().catch(() => ({ name: "", slug: null as string | null })),
  ]);

  const mgr = managerVersion();
  const managerUrl = process.env.MANAGER_PUBLIC_URL?.replace(/\/+$/, "") || "https://manager.<your-access-domain>";
  const one = Array.isArray(sp.tab) ? sp.tab[0] : sp.tab;
  const tab: Tab = (TABS as readonly string[]).includes(one ?? "") ? (one as Tab) : "overview";

  return (
    <main>
      <ConnectorDetail
        key={connector.id}
        serverNow={Date.now()}
        workspace={ws.slug ?? ws.name}
        initialTab={tab}
        c={{
          id: connector.id, name: connector.name, status: connector.status, version: connector.version,
          outdated: isConnectorOutdated(connector.version, mgr), mgr,
          lastSeenAt: connector.lastSeenAt?.toISOString() ?? null, remoteAddr: connector.remoteAddr,
          createdAt: connector.createdAt.toISOString(), egressPolicy: connector.egressPolicy ?? "", logLevel: connector.logLevel ?? "",
          hostAction: storedHostAction(connector.hostAction),
        }}
        tele0={tele}
        sites={connector.sites.map((s) => ({
          tile: siteTile(s),
          publicHost: s.accessMode === "TRANSPARENT" && s.hostname ? s.hostname : null,
          ok: s.probeOk, latencyMs: s.probeLatencyMs, detail: s.probeDetail,
        }))}
        activity={mergeActivity(events.map((e) => ({
          id: e.id, at: e.timestamp.toISOString(), user: e.userName || e.userEmail || "—", siteId: e.siteId, siteName: e.siteName ?? "—",
          method: e.method, path: e.path, allow: e.decision === "ALLOW",
        })))}
        auditHref={siteIds.length === 1 ? `/admin/audit?siteId=${siteIds[0]}` : "/admin/audit"}
        defaultLogLevel={defaultLogLevel}
        updateCommand={{ remote: buildConnectorUpdateCommand(managerUrl, connectorTunnelUrl()), manual: buildConnectorUpdateCommand(managerUrl, connectorTunnelUrl(), false) }}
        managerUrlIsLocal={isLocalManagerUrl(managerUrl)}
      />
    </main>
  );
}

export default async function ConnectorDetailPage(...args: Parameters<typeof ConnectorDetailPageImpl>) {
  // Reads the connector's live counters: up to the telemetry timeout, so the slow budget.
  return withRequestTenant(() => ConnectorDetailPageImpl(...args), { budgetMs: SLOW_SCOPE_BUDGET_MS });
}
