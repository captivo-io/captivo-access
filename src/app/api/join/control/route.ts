import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { guestFromPass } from "@/lib/live/invites";
import { GUEST_COOKIE, guestViewerId } from "@/lib/live/invite-token";
import { setSessionControl } from "@/lib/dataplane/client";
import { recordAdminAction } from "@/lib/audit/admin";
import { clientIp } from "@/lib/request-ip";
import { withTenantRoute } from "@/lib/tenant/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// An invited guest takes or gives back control of the one session their invite
// is for, when the invite allows it. An admin can take it back at any time.
export const POST = withTenantRoute(async (req: Request) => {
  const g = await guestFromPass((await cookies()).get(GUEST_COOKIE)?.value);
  if (!g) return NextResponse.json({ ok: false, reason: "invite_ended" }, { status: 401 });
  if (!g.canControl) return NextResponse.json({ ok: false, reason: "view_only" }, { status: 403 });
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const action = body.action === "release" ? "release" : "take";
  const result = await setSessionControl(g.sessionId, guestViewerId(g.id), action, { guestName: g.guestName });
  if (!result.ok) return NextResponse.json({ ok: false, reason: result.reason ?? "failed" }, { status: 409 });
  await recordAdminAction({
    actor: { id: guestViewerId(g.id), email: g.email },
    action: action === "take" ? "session_invite.take_control" : "session_invite.release_control",
    targetType: "session_invite",
    targetId: g.id,
    summary: `${g.guestName} (${g.email}), an invited guest, ${action === "take" ? "took control of" : "gave back control of"} a live session`,
    metadata: { sessionId: g.sessionId, siteId: g.siteId },
    clientIp: clientIp(req.headers) ?? null,
  });
  return NextResponse.json({ ok: true });
});
