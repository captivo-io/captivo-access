import { NextResponse } from "next/server";
import { requireUser } from "@/lib/current-user";
import { recordAdminAction } from "@/lib/audit/admin";
import { findOwnSession, sendSessionMessage } from "@/lib/dataplane/client";
import { clientIp } from "@/lib/request-ip";
import { withTenantRoute } from "@/lib/tenant/request";
import { mayActOnSession } from "@/lib/moderation/live";

const MAX_MESSAGE = 280;

/**
 * Show a message on the user's screen during a live session (it appears on
 * their session page within a few seconds, or as a line in their terminal on
 * recorded native SSH). Every message is in the admin
 * audit chain, with the text.
 */
export const POST = withTenantRoute(async (req: Request, ctx: { params: Promise<{ sessionId: string }> }) => {
  const admin = await requireUser();
  const { sessionId } = await ctx.params;
  if (!(await mayActOnSession(admin, sessionId))) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const body = (await req.json().catch(() => ({}))) as { text?: unknown };
  const text = typeof body.text === "string" ? body.text.trim().slice(0, MAX_MESSAGE) : "";
  if (!text) return NextResponse.json({ error: "empty" }, { status: 400 });
  const session = await findOwnSession(sessionId);
  if (!session) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const sent = await sendSessionMessage(sessionId, text);
  if (!sent) return NextResponse.json({ error: "not_delivered" }, { status: 502 });
  await recordAdminAction({
    actor: { id: admin.id, email: admin.email },
    action: "session.message",
    targetType: "session", targetId: sessionId,
    summary: `Sent a message to a live session on ${session.host}: "${text}"`,
    metadata: { userId: session.userId, siteId: session.siteId },
    clientIp: clientIp(req.headers) ?? null,
  });
  return NextResponse.json({ ok: true, message: sent.message, delivery: sent.delivery });
});
