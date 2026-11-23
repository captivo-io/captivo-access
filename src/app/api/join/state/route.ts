import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { db } from "@/lib/db";
import { guestFromPass } from "@/lib/live/invites";
import { GUEST_COOKIE, guestViewerId, parseGuestPass } from "@/lib/live/invite-token";
import { findOwnSession } from "@/lib/dataplane/client";
import { withTenantRoute } from "@/lib/tenant/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// What a guest's page polls: whether their invite and the session still hold,
// and who has control.
export const GET = withTenantRoute(async () => {
  const pass = (await cookies()).get(GUEST_COOKIE)?.value;
  const g = await guestFromPass(pass);
  if (!g) {
    const p = parseGuestPass(pass);
    const row = p ? await db.sessionInvite.findUnique({ where: { id: p.id }, select: { revokedAt: true, expiresAt: true } }) : null;
    const state = row?.revokedAt ? "removed" : row && row.expiresAt.getTime() <= Date.now() ? "expired" : "none";
    return NextResponse.json({ state });
  }
  const s = await findOwnSession(g.sessionId);
  if (!s) return NextResponse.json({ state: "ended" });
  const me = guestViewerId(g.id);
  return NextResponse.json({
    state: "live",
    controlling: s.controlOwner === me,
    controlledByOther: s.controlOwner !== "" && s.controlOwner !== me,
    expiresAt: g.expiresAt.toISOString(),
  });
});
