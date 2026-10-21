import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { db } from "@/lib/db";
import { withTenantRoute } from "@/lib/tenant/request";
import { currentTenantId } from "@/lib/tenant/context";
import { PLATFORM_TENANT_ID } from "@/lib/tenant/constants";
import { tenantSlugByOrg, tenantSlugAndName } from "@/lib/platform/sql";
import { reconcileCenterRole } from "@/lib/auth/center-role";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The centre telling this workspace at once that an organisation member's
 * role changed or that they were removed. The same decision the sign-in
 * callback makes (lib/auth/center-role.ts), applied now rather than at the
 * next sign-in, and the person's sessions here end with it.
 *
 * Reached on the tenant's own console host, like the summary endpoint, so
 * the tenant scope is the request's. Only users the centre manages
 * (centerRole set) are touched.
 */
export const POST = withTenantRoute(async (req: Request) => {
  const expected = process.env.CAPTIVO_ID_SERVICE_SECRET?.trim() ?? "";
  const given = req.headers.get("x-captivo-service") ?? "";
  if (!expected || !secretMatches(given, expected)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const tenantId = currentTenantId();
  if (tenantId === PLATFORM_TENANT_ID) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const body = (await req.json().catch(() => null)) as { org?: unknown; email?: unknown; role?: unknown; signOut?: unknown; newEmail?: unknown } | null;
  const org = typeof body?.org === "string" ? body.org.trim() : "";
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  const signOut = body?.signOut === true;
  const newEmail = typeof body?.newEmail === "string" ? body.newEmail.trim().toLowerCase() : "";
  const role = body?.role === null ? null : typeof body?.role === "string" ? body.role : undefined;
  if (!org || !email || (role === undefined && !signOut && !newEmail)) return NextResponse.json({ error: "bad_request" }, { status: 400 });

  const tenant = await tenantSlugAndName(tenantId);
  if (!tenant || (await tenantSlugByOrg(org)) !== tenant.slug) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const user = await db.user.findFirst({
    where: { email: { equals: email, mode: "insensitive" } },
    select: { id: true, role: true, centerRole: true, status: true },
  });
  if (!user || user.centerRole === null) return NextResponse.json({ applied: false }, { headers: { "Cache-Control": "no-store" } });

  // The address changed at the centre: the user here follows it, unless the
  // new address is already a user of this workspace.
  if (newEmail) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail)) return NextResponse.json({ error: "bad_request" }, { status: 400 });
    const taken = await db.user.findFirst({ where: { email: { equals: newEmail, mode: "insensitive" } }, select: { id: true } });
    if (taken && taken.id !== user.id) return NextResponse.json({ applied: false, outcome: "email_taken" }, { status: 409 });
    await db.user.update({ where: { id: user.id }, data: { email: newEmail } });
    await db.session.deleteMany({ where: { userId: user.id } });
    return NextResponse.json({ applied: true, outcome: "renamed" }, { headers: { "Cache-Control": "no-store" } });
  }

  // Single sign-out: the person's session at the centre ended, so theirs
  // here end too. Nothing else changes.
  if (signOut) {
    await db.session.deleteMany({ where: { userId: user.id } });
    return NextResponse.json({ applied: true, outcome: "signed_out" }, { headers: { "Cache-Control": "no-store" } });
  }

  const verdict = reconcileCenterRole(user, role);
  if (verdict.outcome === "unchanged") return NextResponse.json({ applied: false }, { headers: { "Cache-Control": "no-store" } });
  if (verdict.outcome === "revoked") {
    await db.user.update({ where: { id: user.id }, data: { status: "DISABLED" } });
  } else {
    await db.user.update({ where: { id: user.id }, data: { role: verdict.role, centerRole: verdict.centerRole, status: verdict.status } });
  }
  await db.session.deleteMany({ where: { userId: user.id } });
  console.info(`[oidc] membership pushed for ${user.id}: ${verdict.outcome}`);
  return NextResponse.json({ applied: true, outcome: verdict.outcome }, { headers: { "Cache-Control": "no-store" } });
});

function secretMatches(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
