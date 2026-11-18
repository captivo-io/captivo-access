import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/current-user";
import { can } from "@/lib/auth/roles";
import { db } from "@/lib/db";
import { grantCapError } from "@/lib/access/grant-edit";
import { limitDays, limitedEndsAt } from "@/lib/access/grant-view";
import { resolvedMaxGrantDays } from "@/lib/settings/platform";
import { recordAdminAction } from "@/lib/audit/admin";
import { clientIp } from "@/lib/request-ip";
import { withTenantRoute } from "@/lib/tenant/request";

const MAX_IDS = 500;

// Revoke several grants, or give them an end date ("limit to 30 days"). Each
// changed grant is logged on its own, as the single-grant routes do; grants
// that are no longer active are skipped.
export const POST = withTenantRoute(async (req: NextRequest) => {
  const admin = await getCurrentUser();
  if (!admin) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const ids = Array.isArray(body.ids) ? [...new Set(body.ids.filter((v): v is string => typeof v === "string" && v !== ""))] : [];
  if (ids.length === 0) return NextResponse.json({ error: "ids_required" }, { status: 400 });
  if (ids.length > MAX_IDS) return NextResponse.json({ error: "too_many" }, { status: 400 });
  const action = body.action;
  if (action !== "revoke" && action !== "limit") return NextResponse.json({ error: "invalid_action" }, { status: 400 });
  // Same capabilities as the single-grant routes: revoke = approve_grants, an end date = configure.
  if (!can(admin.role, action === "revoke" ? "approve_grants" : "configure")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const ip = clientIp(req.headers) ?? null;
  const actor = { id: admin.id, email: admin.email };
  const grants = await db.accessGrant.findMany({ where: { id: { in: ids }, status: "ACTIVE" }, select: { id: true, startsAt: true, endsAt: true } });

  if (action === "revoke") {
    let done = 0;
    for (const g of grants) {
      const res = await db.accessGrant.updateMany({ where: { id: g.id, status: "ACTIVE" }, data: { status: "REVOKED" } });
      if (res.count === 0) continue;
      done++;
      await recordAdminAction({ actor, action: "grant.revoke", targetType: "grant", targetId: g.id, summary: `Revoked access grant ${g.id}`, clientIp: ip });
    }
    return NextResponse.json({ ok: true, done, skipped: ids.length - done });
  }

  const asked = typeof body.days === "number" && Number.isInteger(body.days) && body.days > 0 && body.days <= 365 ? body.days : 30;
  const cap = await resolvedMaxGrantDays();
  const days = limitDays(asked, cap);
  const now = new Date();
  let done = 0;
  for (const g of grants) {
    const endsAt = limitedEndsAt(g.endsAt, now, days);
    if (!endsAt || (g.endsAt && g.endsAt <= now)) continue; // already ends by then, or already ended
    if (grantCapError(g.startsAt, endsAt, now, cap)) continue;
    const res = await db.accessGrant.updateMany({ where: { id: g.id, status: "ACTIVE" }, data: { endsAt } });
    if (res.count === 0) continue;
    done++;
    await recordAdminAction({
      actor, action: "grant.update", targetType: "grant", targetId: g.id,
      summary: `Updated access grant ${g.id}`, metadata: { endsAt: endsAt.toISOString() }, clientIp: ip,
    });
  }
  return NextResponse.json({ ok: true, done, skipped: ids.length - done, days });
});
