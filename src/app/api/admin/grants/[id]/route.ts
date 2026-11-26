import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/current-user";
import { can } from "@/lib/auth/roles";
import { db } from "@/lib/db";
import { grantEndsAtError, grantCapError } from "@/lib/access/grant-edit";
import { resolvedMaxGrantDays } from "@/lib/settings/platform";
import { recordAdminAction } from "@/lib/audit/admin";
import { clientIp } from "@/lib/request-ip";
import { withTenantRoute } from "@/lib/tenant/request";
import { validCheckoutMinutes } from "@/lib/vault/checkout-limits";

const NOTE_MAX = 500;

export const PATCH = withTenantRoute(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const admin = await getCurrentUser();
  if (!admin) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!can(admin.role, "configure")) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { id } = await ctx.params;

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const hasEndsAt = typeof body.endsAt === "string" && body.endsAt.trim() !== "";
  const hasNote = "note" in body; // note may be intentionally cleared to ""
  const hasCheckout = typeof body.passwordCheckout === "boolean";
  if (!hasEndsAt && !hasNote && !hasCheckout) return NextResponse.json({ error: "nothing_to_update" }, { status: 400 });

  const grant = await db.accessGrant.findUnique({ where: { id }, select: { status: true, startsAt: true } });
  if (!grant) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (grant.status !== "ACTIVE") return NextResponse.json({ error: "not_active" }, { status: 409 });

  const data: { endsAt?: Date; note?: string | null; checkoutDenied?: boolean; checkoutMinutes?: number | null } = {};
  if (hasEndsAt) {
    const endsAt = new Date((body.endsAt as string).trim());
    const err = grantEndsAtError(endsAt, grant.startsAt, new Date());
    if (err) return NextResponse.json({ error: err }, { status: 400 });
    const capErr = grantCapError(grant.startsAt, endsAt, new Date(), await resolvedMaxGrantDays());
    if (capErr) return NextResponse.json({ error: capErr }, { status: 400 });
    data.endsAt = endsAt;
  }
  if (hasNote) {
    if (typeof body.note !== "string") return NextResponse.json({ error: "invalid_note" }, { status: 400 });
    const note = body.note.trim();
    if (note.length > NOTE_MAX) return NextResponse.json({ error: "note_too_long" }, { status: 400 });
    data.note = note || null;
  }

  if (hasCheckout) {
    const on = body.passwordCheckout === true;
    const minutes = on && body.checkoutMinutes != null ? validCheckoutMinutes(body.checkoutMinutes) : null;
    if (on && body.checkoutMinutes != null && minutes === null) return NextResponse.json({ error: "invalid_checkout_minutes" }, { status: 400 });
    data.checkoutDenied = !on;
    data.checkoutMinutes = minutes;
  }

  // Conditional update: only if still ACTIVE, closing the check→write race
  // (mirrors the repo's deleteMany/updateMany idiom). count 0 ⇒ raced to non-active.
  const res = await db.accessGrant.updateMany({ where: { id, status: "ACTIVE" }, data });
  if (res.count === 0) return NextResponse.json({ error: "not_active" }, { status: 409 });
  await recordAdminAction({
    actor: { id: admin.id, email: admin.email },
    action: "grant.update",
    targetType: "grant", targetId: id,
    summary: `Updated access grant ${id}`,
    metadata: { endsAt: data.endsAt ? data.endsAt.toISOString() : undefined, ...(hasCheckout ? { passwordCheckout: !data.checkoutDenied, checkoutMinutes: data.checkoutMinutes ?? null } : {}) },
    clientIp: clientIp(req.headers) ?? null,
  });
  return NextResponse.json({ ok: true });
});
