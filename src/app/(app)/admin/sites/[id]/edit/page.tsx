import Link from "next/link";
import { requireAdmin } from "@/lib/current-user";
import { db } from "@/lib/db";
import { getVaultCredentialMeta } from "@/lib/vault/store";
import { egressReportOnlyUntil } from "@/lib/isolation/egress";
import { recentEgressEvents } from "@/lib/isolation/egress-events";
import { resourceContext } from "../../context";
import { EditResource } from "./edit-resource";
import { withRequestTenant } from "@/lib/tenant/request";

export const dynamic = "force-dynamic";
export const metadata = { title: "Edit resource" };

// The same form as "Add resource" (design hand-off 10, 7.20), filled in.
async function EditSitePageImpl({ params }: { params: Promise<{ id: string }> }) {
  await requireAdmin();
  const { id } = await params;
  const site = await db.site.findUnique({
    where: { id },
    select: {
      id: true, connectorId: true, name: true, hostname: true, upstreamUrl: true, description: true, insecureSkipVerify: true, recordSessions: true,
      keystrokeLogging: true, nativeRdp: true, nativeSsh: true, clipboardMode: true, watermark: true, fileTransferMode: true, accessMode: true, logoType: true, customDomain: true,
      domainVerifiedAt: true, egressMode: true, egressHosts: true, createdAt: true, iconName: true, iconColor: true, logoBg: true,
    },
  });
  if (!site) {
    return (
      <main>
        <div className="page-head"><div><h1>Edit resource</h1><p><Link href="/admin/sites">← Back to resources</Link></p></div></div>
        <div className="au-empty"><b>Resource not found</b></div>
      </main>
    );
  }
  const [ctx, vault, egressEvents] = await Promise.all([
    resourceContext(),
    site.accessMode === "GATEWAY" ? getVaultCredentialMeta(site.id) : Promise.resolve(null),
    site.accessMode === "ISOLATED" ? recentEgressEvents(site.id) : Promise.resolve(undefined),
  ]);

  return (
    <main>
      <div className="page-head">
        <div>
          <div className="eyebrow"><Link href="/admin/sites">Resources</Link> · edit</div>
          <h1>{site.name}</h1>
          <p>Change how this resource is reached and what its sessions allow. Changes apply to new sessions.</p>
        </div>
      </div>
      <EditResource
        ctx={ctx}
        vault={vault ?? undefined}
        egressEvents={egressEvents}
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
          nativeRdp: site.nativeRdp,
          nativeSsh: site.nativeSsh,
          clipboardMode: site.clipboardMode,
          watermark: site.watermark,
          fileTransferMode: site.fileTransferMode,
          egressMode: site.egressMode,
          egressHosts: site.egressHosts,
          egressReportOnlyUntil: egressReportOnlyUntil({ ...site, upstreamUrl: site.upstreamUrl })?.toISOString() ?? null,
          accessMode: site.accessMode,
          hasLogo: site.logoType != null,
          customDomain: site.customDomain,
          domainVerifiedAt: site.domainVerifiedAt?.toISOString() ?? null,
          iconName: site.iconName,
          iconColor: site.iconColor,
          logoBg: site.logoBg,
        }}
      />
    </main>
  );
}

export default async function EditSitePage(...args: Parameters<typeof EditSitePageImpl>) {
  return withRequestTenant(() => EditSitePageImpl(...args));
}
