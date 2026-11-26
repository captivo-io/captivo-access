import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/current-user";
import { clientIp } from "@/lib/request-ip";
import { withTenantRoute } from "@/lib/tenant/request";
import { SLOW_SCOPE_BUDGET_MS } from "@/lib/tenant/scope";
import { evaluateAccess } from "@/lib/access/evaluate";
import { activeCheckout, checkoutBlock, checkoutGrant, checkoutMinutesFor, CHECKOUT_BLOCK_TEXT, CHECKOUT_NOT_GRANTED_TEXT, endCheckout, startCheckout } from "@/lib/vault/checkout";
import { resolvedCheckoutRequiresReason } from "@/lib/settings/platform";
import { rotationStatus } from "@/lib/vault/rotation-status";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// What the check-out dialog shows: whether the password can be checked out, by
// whom it is now, for how long it would be, and whether it is changed afterwards.
export const GET = withTenantRoute(async (_req: NextRequest, ctx: { params: Promise<{ siteId: string }> }) => {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { siteId } = await ctx.params;
  const now = new Date();
  if (!(await evaluateAccess(user.id, siteId, now)).allow) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const site = await db.site.findUnique({ where: { id: siteId }, select: { accessMode: true, passwordCheckout: true, checkoutMaxMinutes: true, requireModerator: true, vaultCredential: { select: { secretKind: true, secretSource: true, sealedTo: true } } } });
  if (!site) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const cg = await checkoutGrant(user.id, siteId, now);
  const resourceBlock = checkoutBlock(site, site.vaultCredential);
  // A grant made without the password gets the same answer as a resource that has it off.
  const block = resourceBlock ?? (cg ? null : "not_granted" as const);
  const active = await activeCheckout(siteId, now);
  const st = block ? null : await rotationStatus(siteId);
  return NextResponse.json({
    block, blockText: block === "not_granted" ? CHECKOUT_NOT_GRANTED_TEXT : block ? CHECKOUT_BLOCK_TEXT[block] : null,
    maxMinutes: checkoutMinutesFor(site.checkoutMaxMinutes, cg?.minutes ?? null),
    reasonRequired: await resolvedCheckoutRequiresReason(),
    grantEnds: cg?.end?.toISOString() ?? null,
    willRotate: !!st && !st.unsupported && st.method !== null,
    waiting: st?.waiting ?? null,
    active: active ? { mine: active.userId === user.id, who: active.userId === user.id ? "you" : active.userName, until: active.endsAt.toISOString(), id: active.id } : null,
  }, { headers: { "cache-control": "no-store" } });
});

// start: take the password (sealed to the key this browser made for it);
// return: give it back early.
export const POST = withTenantRoute(async (req: NextRequest, ctx: { params: Promise<{ siteId: string }> }) => {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { siteId } = await ctx.params;
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const now = new Date();

  if (b.action === "return") {
    const mine = await db.credentialCheckout.findFirst({ where: { siteId, userId: user.id, endedBy: null }, select: { id: true } });
    if (!mine) return NextResponse.json({ error: "not_checked_out" }, { status: 409 });
    await endCheckout(mine.id, "returned", { id: user.id, email: user.email }, now);
    return NextResponse.json({ ok: true });
  }

  const cg = await checkoutGrant(user.id, siteId, now);
  if (!cg) return NextResponse.json({ error: "checkout_not_granted", detail: CHECKOUT_NOT_GRANTED_TEXT }, { status: 403 });
  const r = await startCheckout({
    userId: user.id, userEmail: user.email, siteId, reason: typeof b.reason === "string" ? b.reason : "", publicKey: typeof b.publicKey === "string" ? b.publicKey : "",
    grantEnd: cg.end, grantMinutes: cg.minutes, ip: clientIp(req.headers) ?? null, now,
  });
  if (!r.ok) return NextResponse.json({ error: r.error, detail: r.detail, by: r.by, until: r.until?.toISOString() }, { status: r.status });
  return NextResponse.json({ id: r.id, sealed: r.sealed, target: r.target, endsAt: r.endsAt.toISOString(), willRotate: r.willRotate });
}, { budgetMs: SLOW_SCOPE_BUDGET_MS });
