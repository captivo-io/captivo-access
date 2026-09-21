import { NextResponse, type NextRequest } from "next/server";
import { withTenantRoute } from "@/lib/tenant/request";
import { currentTenantId } from "@/lib/tenant/context";
import { PLATFORM_TENANT_ID } from "@/lib/tenant/constants";
import { readWorkspaceClaim } from "@/lib/signup/workspace-claim";
import { provisionEntitledWorkspace } from "@/lib/signup/entitled-flow";
import { fetchAccessEntitlement, reportTenantLink } from "@/lib/auth/captivo-id-client";
import { createTenant } from "@/lib/platform/tenants";
import { tenantSlugByOrg } from "@/lib/platform/sql";
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
  // Reserved before shape: a reserved slug is well-formed, so answering
  // invalid_slug sent the person off hunting for a typo that was not there.
  if (isReservedSlug(slug)) return NextResponse.json({ error: "reserved_slug" }, { status: 400 });
  if (!isValidTenantSlug(slug)) return NextResponse.json({ error: "invalid_slug" }, { status: 400 });

  const result = await provisionEntitledWorkspace(
    { organizationId: claim.org, organizationName: claim.orgName, slug, adminEmail: claim.email, adminName: claim.name },
    {
      fetchEntitlement: (org) => fetchAccessEntitlement(org),
      findWorkspaceForOrg: async (org) => {
        const existing = await tenantSlugByOrg(org);
        return existing ? { slug: existing } : null;
      },
      create: (input) => createTenant(input),
      reportLink: (input) => reportTenantLink(input),
      consoleOriginFor: (s) => {
        const d = consoleDomain();
        return d ? `https://${s}.${d}` : null;
      },
    },
  );

  if (!result.ok) {
    // 409 conflict / 403 refused / 503 "ask again" / 400 "fix the request".
    // already_provisioned carries the address of the workspace that already
    // exists, so the person is sent somewhere useful instead of being told no.
    const STATUS: Record<string, number> = {
      slug_taken: 409,
      already_provisioned: 409,
      not_entitled: 403,
      entitlement_expired: 403,
      centre_unavailable: 503,
    };
    const d = consoleDomain();
    const consoleUrl = result.existingSlug && d ? `https://${result.existingSlug}.${d}` : undefined;
    return NextResponse.json(
      { error: result.error, ...(consoleUrl ? { consoleUrl } : {}) },
      { status: STATUS[result.error] ?? 400 },
    );
  }

  const res = NextResponse.json({ inviteUrl: result.inviteUrl, linked: result.linked }, { status: 201 });
  // The handoff is spent.
  // Same path the callback wrote it at -- clearing at a different path leaves
  // the cookie in the jar.
  res.cookies.set("captivo_workspace", "", { path: "/", maxAge: 0 });
  return res;
});
