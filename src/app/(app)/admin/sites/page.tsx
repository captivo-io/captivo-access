import { requireAdmin } from "@/lib/current-user";
import { db } from "@/lib/db";
import { sealsOf } from "@/lib/vault/store";
import { timeAgo } from "@/lib/format";
import { recordingEnabled } from "@/lib/recording/enabled";
import { AddSiteButton } from "./add-site-button";
import { resourceContext } from "./context";
import { resolvedRecordingMode, resolvedKeystrokeLoggingMode } from "@/lib/settings/platform";
import { planUsage } from "@/lib/platform/plan-usage";
import { PlanUsageNote } from "@/app/(app)/_shell/plan-usage-note";
import { SitesView, type SiteRow } from "./sites-view";
import { withRequestTenant } from "@/lib/tenant/request";

export const dynamic = "force-dynamic";
export const metadata = { title: "Resources" };

async function AdminSitesPageImpl({ searchParams }: { searchParams: Promise<{ q?: string; status?: string; new?: string }> }) {
  const sp = await searchParams;
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
        keystrokeLogging: true,
        clipboardMode: true,
        logoType: true,
        iconName: true,
        iconColor: true,
        logoBg: true,
        connector: { select: { name: true, status: true } },
        connectorGroupId: true,
        connectorGroup: { select: { name: true, members: { select: { connector: { select: { status: true } } } } } },
        vaultCredential: { select: { targetHost: true, targetPort: true, protocol: true, sealedTo: true, secret: true, extraSeals: true } },
        _count: { select: { grants: true } },
      },
      orderBy: { createdAt: "desc" },
    }),
    db.connector.findMany({
      where: { status: { not: "REVOKED" } },
      select: { id: true, name: true, vaultPublicKey: true },
      orderBy: { name: "asc" },
    }),
  ]);
  const groupRows = await db.connectorGroup.findMany({
    orderBy: { name: "asc" },
    select: { id: true, name: true, members: { where: { connector: { status: { not: "REVOKED" } } }, select: { connector: { select: { vaultPublicKey: true } } } } },
  });
  const groups = groupRows.filter((g) => g.members.length > 0).map((g) => ({ id: g.id, name: g.name, keys: g.members.map((m) => m.connector.vaultPublicKey).filter((k): k is string => !!k) }));

  const rows: SiteRow[] = sites.map((s) => ({
    id: s.id,
    name: s.name,
    hostname: s.hostname ?? "",
    upstreamUrl: s.upstreamUrl,
    description: s.description,
    accessMode: s.accessMode,
    gatewayTarget: s.vaultCredential ? `${s.vaultCredential.targetHost}:${s.vaultCredential.targetPort}` : null,
    protocol: s.accessMode === "GATEWAY" && s.vaultCredential ? String(s.vaultCredential.protocol).toUpperCase() : null,
    hasLogo: s.logoType != null,
    iconName: s.iconName,
    iconColor: s.iconColor,
    logoBg: s.logoBg,
    connectorId: s.connectorId,
    sealed: !!s.vaultCredential?.sealedTo,
    sealedKeys: s.vaultCredential ? Object.keys(sealsOf(s.vaultCredential)) : [],
    connectorGroupId: s.connectorGroupId,
    insecureSkipVerify: s.insecureSkipVerify,
    recordSessions: s.recordSessions,
    keystrokeLogging: s.keystrokeLogging,
    clipboardMode: s.clipboardMode,
    // A group resource shows its group, up while any member is online.
    connectorName: s.connectorGroup ? s.connectorGroup.name : s.connector.name,
    connectorOnline: s.connectorGroup ? s.connectorGroup.members.some((m) => m.connector.status === "ONLINE") : s.connector.status === "ONLINE",
    isGroup: !!s.connectorGroup,
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
          <div className="eyebrow">Infrastructure · {sites.length} resource{sites.length === 1 ? "" : "s"}</div>
          <h1>Resources</h1>
          <p>
            A resource is an internal upstream reached through a connector. Send a live test to verify the
            tunnel works end to end.
          </p>
          <PlanUsageNote usage={siteUsage} noun="resources" />
        </div>
        <div className="row-actions"><span id="rs-head-actions" className="rs-head-actions" />{connectors.length > 0 && <AddSiteButton ctx={await resourceContext()} initialOpen={sp.new === "1"} />}</div>
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
        <SitesView sites={rows} connectors={connectors} groups={groups} recordingEnabled={recordingEnabled()} recordingMode={await resolvedRecordingMode()} keystrokeMode={await resolvedKeystrokeLoggingMode()} initialQuery={typeof sp.q === "string" ? sp.q : ""} initialStatus={sp.status === "down" || sp.status === "up" ? sp.status : "all"} />
      )}
    </main>
  );
}

export default async function AdminSitesPage(...args: Parameters<typeof AdminSitesPageImpl>) {
  return withRequestTenant(() => AdminSitesPageImpl(...args));
}

