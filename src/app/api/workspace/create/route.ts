import { NextResponse, type NextRequest } from "next/server";
import { withTenantRoute } from "@/lib/tenant/request";
import { currentTenantId } from "@/lib/tenant/context";
import { PLATFORM_TENANT_ID } from "@/lib/tenant/constants";
import { readWorkspaceClaim } from "@/lib/signup/workspace-claim";
import { provisionEntitledWorkspace } from "@/lib/signup/entitled-flow";
import { fetchAccessEntitlement, reportTenantLink } from "@/lib/auth/captivo-id-client";
import { createTenant } from "@/lib/platform/tenants";
import { consoleDomain } from "@/lib/tenant/console-domain";
import { isValidTenantSlug, isReservedSlug } from "@/lib/tenant/constants";

export const dynamic = "force-dynamic";

/**
 * Create the workspace an entitled identity is owed.
 *
 * The organisation comes from the SIGNED claim set at the end of the Captivo ID
 * callback, never from the request body -- the body is whatever the browser
 * sent, and trusting it here would let anyone who reaches this route create a
 * workspace for an organisation they have no grant for. The slug is the one
 * thing the person chooses.
 */
export const POST = withTenantRoute(async (req: NextRequest) => {
  if (currentTenantId() !== PLATFORM_TENANT_ID) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const claim = readWorkspaceClaim(req.cookies.get("captivo_workspace")?.value, process.env.CAPTIVO_ID_CLIENT_SECRET ?? "");
  if (!claim) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as { slug?: unknown };
  const slug = String(body?.slug ?? "").trim().toLowerCase();
  if (!isValidTenantSlug(slug) || isReservedSlug(slug)) {
    return NextResponse.json({ error: "invalid_slug" }, { status: 400 });
  }

  const result = await provisionEntitledWorkspace(
    { organizationId: claim.org, organizationName: claim.orgName, slug, adminEmail: claim.email, adminName: claim.name },
    {
      fetchEntitlement: (org) => fetchAccessEntitlement(org),
      create: (input) => createTenant(input),
      reportLink: (input) => reportTenantLink(input),
      consoleOriginFor: (s) => {
        const d = consoleDomain();
        return d ? `https://${s}.${d}` : null;
      },
    },
  );

  if (!result.ok) {
    const status = result.error === "slug_taken" ? 409 : result.error === "not_entitled" ? 403 : 400;
    return NextResponse.json({ error: result.error }, { status });
  }

  const res = NextResponse.json({ inviteUrl: result.inviteUrl, linked: result.linked }, { status: 201 });
  // The handoff is spent.
  res.cookies.set("captivo_workspace", "", { path: "/workspace", maxAge: 0 });
  return res;
});
