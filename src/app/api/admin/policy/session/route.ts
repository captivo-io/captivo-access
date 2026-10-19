import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/current-user";
import { recordAdminAction } from "@/lib/audit/admin";
import { clientIp } from "@/lib/request-ip";
import { can } from "@/lib/auth/roles";
import { saveSessionPolicy } from "@/lib/policy/session-policy";
import { withTenantRoute } from "@/lib/tenant/request";
import { currentSessionId } from "@/lib/auth/session";
import { hasSecondFactor } from "@/lib/auth/amr";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function toInt(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

export const POST = withTenantRoute(async (req: NextRequest) => {
  const admin = await getCurrentUser();
  if (!admin) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!can(admin.role, "configure")) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const body = await req.json().catch(() => ({}));
  const requireSecondFactor = body.requireSecondFactor === true;

  // Turning the requirement on is refused unless the admin's OWN sign-in would
  // pass it. The alternative is a workspace locked by a switch the person who
  // flipped it cannot get past -- and a support call that begins with "I
  // enabled security and now nobody can sign in". The check is on this
  // request's session, not the account: what matters is how THEY got in.
  if (requireSecondFactor) {
    const sid = await currentSessionId();
    const own = sid ? await db.session.findUnique({ where: { id: sid }, select: { amr: true } }) : null;
    if (!own || !hasSecondFactor(own.amr)) {
      return NextResponse.json({ error: "own_session_lacks_second_factor" }, { status: 409 });
    }
  }

  await saveSessionPolicy({
    idleTimeoutMinutes: toInt(body.idleTimeoutMinutes),
    maxSessionHours: toInt(body.maxSessionHours),
    maxConcurrentPerUser: toInt(body.maxConcurrentPerUser),
    requireSecondFactor,
  });
  await recordAdminAction({
    actor: { id: admin.id, email: admin.email },
    action: "config.session_policy_update",
    summary: `Updated session policy (two-step verification ${requireSecondFactor ? "required" : "not required"})`,
    metadata: { requireSecondFactor },
    clientIp: clientIp(req.headers) ?? null,
  });
  return NextResponse.json({ ok: true });
});
