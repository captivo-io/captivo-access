import Link from "next/link";
import { requireAdmin } from "@/lib/current-user";
import { db } from "@/lib/db";
import { recordingEnabled } from "@/lib/recording/enabled";
import { nativeGatewayEnabled } from "@/lib/gateway/native";
import { isolationEnabled } from "@/lib/isolation/enabled";
import { siteHostSuffix } from "@/lib/site/host-suffix";
import { resolvedKeystrokeLoggingMode, resolvedRecordingMode, resolvedGuacParamDefaults, resolvedClipboardDefault, resolvedWatermarkDefault } from "@/lib/settings/platform";
import { getVaultCredentialMeta } from "@/lib/vault/store";
import { SiteForm } from "../../site-form";
import { withRequestTenant } from "@/lib/tenant/request";

export const dynamic = "force-dynamic";
export const metadata = { title: "Edit resource" };

async function EditSitePageImpl({ params }: { params: Promise<{ id: string }> }) {
  await requireAdmin();
  const { id } = await params;
  const [site, connectors] = await Promise.all([
    db.site.findUnique({
      where: { id },
      select: { id: true, connectorId: true, name: true, hostname: true, upstreamUrl: true, description: true, insecureSkipVerify: true, recordSessions: true, keystrokeLogging: true, clipboardMode: true, watermark: true, fileTransferMode: true, accessMode: true, logoType: true, customDomain: true, domainVerifiedAt: true },
    }),
    db.connector.findMany({ where: { status: { not: "REVOKED" } }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
  ]);

  // Seed the remote-desktop fields from the site's vault credential (secret excluded).
  const vault = site && site.accessMode === "GATEWAY" ? await getVaultCredentialMeta(site.id) : null;
  const keystrokeMode = await resolvedKeystrokeLoggingMode();
  const recordingMode = await resolvedRecordingMode();
  const guacDefaults = await resolvedGuacParamDefaults();
  const [clipboardDefault, watermarkDefault] = await Promise.all([resolvedClipboardDefault(), resolvedWatermarkDefault()]);

  return (
    <main>
      <div className="page-head">
        <div>
          <h1>Edit resource</h1>
          <p><Link href="/admin/sites">← Back to resources</Link></p>
        </div>
      </div>
      {!site ? (
        <div className="empty">Resource not found.</div>
      ) : (
        <div className="card">
          <SiteForm
            connectors={connectors}
            recordingEnabled={recordingEnabled()}
            recordingMode={recordingMode}
            keystrokeMode={keystrokeMode}
            guacDefaults={guacDefaults}
            clipboardDefault={clipboardDefault}
            watermarkDefault={watermarkDefault}
            nativeGateway={nativeGatewayEnabled()}
            isolationEnabled={isolationEnabled()}
            hostSuffix={await siteHostSuffix()}
            vault={vault ?? undefined}
            site={{
              id: site.id,
              connectorId: site.connectorId,
              name: site.name,
              hostname: site.hostname ?? "",
              upstreamUrl: site.upstreamUrl ?? "",
              description: site.description ?? "",
              insecureSkipVerify: site.insecureSkipVerify,
              recordSessions: site.recordSessions,
              keystrokeLogging: site.keystrokeLogging,
              clipboardMode: site.clipboardMode,
              watermark: site.watermark,
              fileTransferMode: site.fileTransferMode,
              accessMode: site.accessMode,
              hasLogo: site.logoType != null,
              customDomain: site.customDomain,
              domainVerifiedAt: site.domainVerifiedAt?.toISOString() ?? null,
            }}
          />
        </div>
      )}
    </main>
  );
}

export default async function EditSitePage(...args: Parameters<typeof EditSitePageImpl>) {
  return withRequestTenant(() => EditSitePageImpl(...args));
}

