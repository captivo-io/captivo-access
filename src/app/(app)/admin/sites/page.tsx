import { requireAdmin } from "@/lib/current-user";
import { SitesIcon } from "@/components/icons";
import { db } from "@/lib/db";
import { timeAgo } from "@/lib/format";
import { recordingEnabled } from "@/lib/recording/enabled";
import { nativeGatewayEnabled } from "@/lib/gateway/native";
import { siteHostSuffix } from "@/lib/site/host-suffix";
import { isolationEnabled } from "@/lib/isolation/enabled";
import { resolvedKeystrokeLoggingMode, resolvedRecordingMode, resolvedGuacParamDefaults } from "@/lib/settings/platform";
import { AddSiteButton } from "./add-site-button";
import { planUsage } from "@/lib/platform/plan-usage";
import { PlanUsageNote } from "@/app/(app)/_shell/plan-usage-note";
import { SitesView, type SiteRow } from "./sites-view";
import { withRequestTenant } from "@/lib/tenant/request";

export const dynamic = "force-dynamic";
export const metadata = { title: "Resources" };

async function AdminSitesPageImpl() {
  await requireAdmin();

  const [sites, connectors] = await Promise.all([
    db.site.findMany({
      select: {
        id: true,
        name: true,
        hostname: true,
        upstreamUrl: true,
        description: true,
        probedAt: true,
        probeOk: true,
        probeDetail: true,
        probeLatencyMs: true,
        accessMode: true,
        connectorId: true,
        insecureSkipVerify: true,
        recordSessions: true,
        clipboardMode: true,
        logoType: true,
        connector: { select: { name: true, status: true } },
        vaultCredential: { select: { targetHost: true, targetPort: true } },
        _count: { select: { grants: true } },
      },
      orderBy: { createdAt: "desc" },
    }),
    db.connector.findMany({
      where: { status: { not: "REVOKED" } },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
  ]);

  const rows: SiteRow[] = sites.map((s) => ({
    id: s.id,
    name: s.name,
    hostname: s.hostname ?? "",
    upstreamUrl: s.upstreamUrl,
    description: s.description,
    accessMode: s.accessMode,
    gatewayTarget: s.vaultCredential ? `${s.vaultCredential.targetHost}:${s.vaultCredential.targetPort}` : null,
    hasLogo: s.logoType != null,
    connectorId: s.connectorId,
    insecureSkipVerify: s.insecureSkipVerify,
    recordSessions: s.recordSessions,
    clipboardMode: s.clipboardMode,
    connectorName: s.connector.name,
    grantCount: s._count.grants,
    probeOk: s.probeOk,
    probeDetail: s.probeDetail,
    probeLatencyMs: s.probeLatencyMs,
    probedAgo: s.probedAt ? timeAgo(s.probedAt) : null,
  }));

  // sites is already the full list for this tenant, so its length IS the count
  // assertWithinLimit uses (api/admin/sites counts every row) -- no second
  // query, and no chance of the two disagreeing.
  const siteUsage = await planUsage("maxSites", sites.length);

  return (
    <main>
      <div className="page-head">
        <div>
          <div className="page-title-row"><span className="page-icon"><SitesIcon /></span><h1>Resources</h1></div>
          <p>
            A resource is an internal upstream reachable through a connector, addressed by its real internal
            URL. Use &quot;Test connection&quot; to verify a live round trip through the connector&apos;s
            tunnel.
          </p>
          <PlanUsageNote usage={siteUsage} noun="resources" />
        </div>
        {connectors.length > 0 && <AddSiteButton connectors={connectors} recordingEnabled={recordingEnabled()} recordingMode={await resolvedRecordingMode()} keystrokeMode={await resolvedKeystrokeLoggingMode()} guacDefaults={await resolvedGuacParamDefaults()} nativeGateway={nativeGatewayEnabled()} isolationEnabled={isolationEnabled()} hostSuffix={await siteHostSuffix()} />}
      </div>

      {sites.length === 0 ? (
        <div className="empty">
          {connectors.length === 0
            ? "Add a connector first before creating a resource."
            : "No resources yet — use \"Add resource\" to publish an internal app."}
        </div>
      ) : (
        // Existing sites always render (with edit/delete), even when the only
        // connector is revoked — otherwise a revoked connector's sites become
        // invisible and neither the sites nor the connector can be removed.
        <SitesView sites={rows} connectors={connectors} recordingEnabled={recordingEnabled()} />
      )}
    </main>
  );
}

export default async function AdminSitesPage(...args: Parameters<typeof AdminSitesPageImpl>) {
  return withRequestTenant(() => AdminSitesPageImpl(...args));
}

