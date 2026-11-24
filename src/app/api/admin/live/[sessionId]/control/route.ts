import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/current-user";
import { setSessionControl } from "@/lib/dataplane/client";
import { appendAuditEvents } from "@/lib/audit/append";
import { clientIp } from "@/lib/request-ip";
import { withTenantRoute } from "@/lib/tenant/request";
import { mayActOnSession } from "@/lib/moderation/live";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withTenantRoute(async (req: Request, { params }: { params: Promise<{ sessionId: string }> }) => {
  const admin = await getCurrentUser();
  if (!admin) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { sessionId } = await params;
  if (!(await mayActOnSession(admin, sessionId))) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const action = body.action === "release" ? "release" : "take";

  // An admin's take also brings back control an invited guest holds.
  const result = await setSessionControl(sessionId, admin.id, action, { force: true });
  if (!result.ok) return NextResponse.json({ ok: false, reason: result.reason ?? "failed" }, { status: 409 });

  try {
    await appendAuditEvents([
      {
        userId: admin.id,
        host: "manager",
        method: "POST",
        path: `/live/${sessionId}`,
        status: 200,
        decision: "ALLOW",
        reason: action === "take" ? "Admin took control of a live session" : "Admin released control of a live session",
        clientIp: clientIp(req.headers),
        userAgent: req.headers.get("user-agent") ?? undefined,
      },
    ]);
  } catch (err) {
    console.error("[live/control] audit append failed:", err);
  }
  return NextResponse.json({ ok: true });
});
