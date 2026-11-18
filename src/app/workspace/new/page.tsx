import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { withRequestTenant } from "@/lib/tenant/request";
import { currentTenantId } from "@/lib/tenant/context";
import { PLATFORM_TENANT_ID } from "@/lib/tenant/constants";
import { readWorkspaceClaim } from "@/lib/signup/workspace-claim";
import { suggestedSlug } from "@/lib/signup/entitled-flow";
import { consoleDomain } from "@/lib/tenant/console-domain";
import { AuthShell } from "@/components/auth-shell";
import { BrandMark } from "@/components/brand";
import { WorkspaceForm } from "./workspace-form";
import { tenantByOrg } from "@/lib/platform/sql";
import { PURGE_AFTER_DAYS } from "@/lib/platform/tenants";
import { restorableUntil, SUPPORT_ADDRESS } from "@/lib/workspace/close-gate";

export const dynamic = "force-dynamic";
export const metadata = { title: "Set up your workspace" };

// Platform-host only, mirroring the create endpoint's own guard: the claim
// cookie is only ever issued from the platform host, and a customer console
// host resolving here would otherwise render a form whose submit can only 404.
async function NewWorkspacePageImpl() {
  if (currentTenantId() !== PLATFORM_TENANT_ID) notFound();

  const jar = await cookies();
  const claim = readWorkspaceClaim(jar.get("captivo_workspace")?.value, process.env.CAPTIVO_ID_CLIENT_SECRET ?? "");
  // No claim means this page was reached without completing the sign-in that
  // issues one. Send them back to the front door rather than explaining.
  if (!claim) redirect("/login");

  // The organisation's workspace was closed and is not purged yet: it still
  // holds the organisation, so a new one can't be made until it is restored or gone.
  const existing = await tenantByOrg(claim.org).catch(() => null);
  if (existing?.deletedAt) {
    const until = restorableUntil(existing.deletedAt, PURGE_AFTER_DAYS).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
    return (
      <AuthShell>
        <BrandMark size={38} className="auth-mark" />
        <h1>{claim.orgName}&apos;s workspace was closed</h1>
        <p>
          The Captivo Access workspace <b>{existing.slug}</b> was closed by an administrator. Its data is kept
          until <b>{until}</b>: to restore it, write to <a href={`mailto:${SUPPORT_ADDRESS}`}>{SUPPORT_ADDRESS}</a>.
        </p>
        <p>After that date it is removed for good and you can set up a new workspace here.</p>
      </AuthShell>
    );
  }

  return (
    <AuthShell>
      <BrandMark size={38} className="auth-mark" />
      <h1>Set up {claim.orgName} on Captivo Access</h1>
      <p>
        Your organisation includes the free tier: one connector and five resources.
        Choose the address your console will live at — your suppliers will use it to sign in.
      </p>
      <WorkspaceForm defaultSlug={suggestedSlug(claim.orgName)} domain={consoleDomain() ?? ""} />
    </AuthShell>
  );
}

export default async function NewWorkspacePage() {
  return withRequestTenant(NewWorkspacePageImpl);
}
