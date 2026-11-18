import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/current-user";
import { recordAdminAction } from "@/lib/audit/admin";
import { clientIp } from "@/lib/request-ip";
import { can } from "@/lib/auth/roles";
import { getPlatformSettingsFresh, savePlatformSettings, saveGuacParamDefaults } from "@/lib/settings/platform";
import { getSessionPolicyFresh, saveSessionPolicy } from "@/lib/policy/session-policy";
import { applyPolicyChanges } from "@/lib/policy/patch";
import { parseGuacParams } from "@/lib/gateway/guac-params";
import { validateAllowlist } from "@/lib/net/cidr";
import { isValidTimeZone } from "@/lib/time/datetime-local";
import { timeZoneManaged } from "@/lib/tenant/center-time-zone";
import { currentSessionId } from "@/lib/auth/session";
import { hasSecondFactor } from "@/lib/auth/amr";
import { db } from "@/lib/db";
import { withTenantRoute } from "@/lib/tenant/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The Policy page saves only what changed: { changes: { key: value } }.
// Untouched settings keep their stored value (null keeps env/default in charge).
export const PATCH = withTenantRoute(async (req: NextRequest) => {
  const admin = await getCurrentUser();
  if (!admin) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!can(admin.role, "configure")) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const body = (await req.json().catch(() => ({}))) as { changes?: unknown };
  const changes = body.changes && typeof body.changes === "object" && !Array.isArray(body.changes) ? (body.changes as Record<string, unknown>) : null;
  if (!changes || Object.keys(changes).length === 0) return NextResponse.json({ error: "nothing_to_update" }, { status: 400 });

  // Fresh reads: a cached copy could undo another admin's save from a moment ago.
  const [platform, session, zoneManaged] = await Promise.all([getPlatformSettingsFresh(), getSessionPolicyFresh(), timeZoneManaged()]);
  const r = applyPolicyChanges({ session, platform }, changes, {
    zoneManaged, validAllowlist: validateAllowlist, validZone: isValidTimeZone, parseGuac: parseGuacParams,
  });
  if ("error" in r) return NextResponse.json(r, { status: 400 });

  // Turning two-step on is refused unless the admin's OWN sign-in would pass it
  // (same guard as api/admin/policy/session): never lock out the person flipping it.
  if (r.session?.requireSecondFactor && !session.requireSecondFactor) {
    const sid = await currentSessionId();
    const own = sid ? await db.session.findUnique({ where: { id: sid }, select: { amr: true } }) : null;
    if (!own || !hasSecondFactor(own.amr)) {
      return NextResponse.json({ error: "own_session_lacks_second_factor", key: "requireSecondFactor" }, { status: 409 });
    }
  }

  const actor = { id: admin.id, email: admin.email };
  const ip = clientIp(req.headers) ?? null;
  if (r.session) {
    await saveSessionPolicy(r.session);
    await recordAdminAction({
      actor, action: "config.session_policy_update",
      summary: `Updated session policy (two-step verification ${r.session.requireSecondFactor ? "required" : "not required"})`,
      metadata: { requireSecondFactor: r.session.requireSecondFactor, changed: r.changed.filter((k) => k in session) },
      clientIp: ip,
    });
  }
  if (r.platform || r.guac) {
    if (r.platform) await savePlatformSettings(r.platform);
    if (r.guac) await saveGuacParamDefaults(r.guac);
    const keys = r.changed.filter((k) => !(k in session));
    await recordAdminAction({
      actor, action: "config.platform_update",
      summary: `Updated policy: ${keys.join(", ")}`,
      metadata: { changed: keys },
      clientIp: ip,
    });
  }
  return NextResponse.json({ ok: true, changed: r.changed });
});
