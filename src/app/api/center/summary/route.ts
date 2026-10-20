import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { withTenantRoute } from "@/lib/tenant/request";
import { currentTenantId } from "@/lib/tenant/context";
import { PLATFORM_TENANT_ID } from "@/lib/tenant/constants";
import { tenantStats, tenantSlugByOrg, tenantSlugAndName } from "@/lib/platform/sql";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * What this workspace tells the Captivo account page about itself.
 *
 * Captivo ID calls this on the workspace's own host, with the shared service
 * secret, to put live numbers on the Access card of the account hub:
 * `{ name, facts }`, where the fact keys are the ones the hub knows how to
 * label. Called on the workspace host on purpose -- the tenant is resolved
 * from the request like everywhere else, so nothing here reaches across
 * tenants -- and the `org` named in the query must be the organisation this
 * workspace is linked to, or the answer is 404: a valid secret alone must not
 * be enough to read one workspace's numbers under another's name.
 */
export const GET = withTenantRoute(async (req: Request) => {
  const expected = process.env.CAPTIVO_ID_SERVICE_SECRET?.trim() ?? "";
  const given = req.headers.get("x-captivo-service") ?? "";
  if (!expected || !secretMatches(given, expected)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const tenantId = currentTenantId();
  if (tenantId === PLATFORM_TENANT_ID) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const org = new URL(req.url).searchParams.get("org")?.trim() ?? "";
  if (!org) return NextResponse.json({ error: "missing_org" }, { status: 400 });

  // Through the platform function: the app role cannot read "Tenant" under RLS.
  const tenant = await tenantSlugAndName(tenantId);
  if (!tenant || (await tenantSlugByOrg(org)) !== tenant.slug) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const stats = (await tenantStats()).get(tenantId);
  const facts: Record<string, number | string> = stats
    ? {
        sites: stats.sites,
        connectors: stats.connectors,
        connectorsOnline: stats.connectorsOnline,
        sessions24h: stats.sessions24h,
        ...(stats.lastActivity ? { lastActivity: stats.lastActivity.toISOString() } : {}),
      }
    : {};

  return NextResponse.json({ name: tenant.name, facts }, { headers: { "Cache-Control": "no-store" } });
});

function secretMatches(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
