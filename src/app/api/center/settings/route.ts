import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { withTenantRoute } from "@/lib/tenant/request";
import { currentTenantId } from "@/lib/tenant/context";
import { PLATFORM_TENANT_ID } from "@/lib/tenant/constants";
import { tenantSlugByOrg, tenantSlugAndName } from "@/lib/platform/sql";
import { applyCenterTimeZone } from "@/lib/tenant/center-time-zone";
import { isValidTimeZone } from "@/lib/time/datetime-local";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The centre telling this workspace that an organisation setting it owns
 * changed -- today the organisation's time zone, which becomes the display
 * zone (lib/tenant/center-time-zone.ts). Same guard and tenant check as
 * /api/center/membership.
 */
export const POST = withTenantRoute(async (req: Request) => {
  const expected = process.env.CAPTIVO_ID_SERVICE_SECRET?.trim() ?? "";
  const given = req.headers.get("x-captivo-service") ?? "";
  if (!expected || !secretMatches(given, expected)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const tenantId = currentTenantId();
  if (tenantId === PLATFORM_TENANT_ID) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const body = (await req.json().catch(() => null)) as { org?: unknown; timeZone?: unknown } | null;
  const org = typeof body?.org === "string" ? body.org.trim() : "";
  const zone = typeof body?.timeZone === "string" ? body.timeZone : "";
  if (!org || !isValidTimeZone(zone)) return NextResponse.json({ error: "bad_request" }, { status: 400 });

  const tenant = await tenantSlugAndName(tenantId);
  if (!tenant || (await tenantSlugByOrg(org)) !== tenant.slug) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const changed = await applyCenterTimeZone(zone);
  return NextResponse.json({ applied: true, changed }, { headers: { "Cache-Control": "no-store" } });
});

function secretMatches(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
