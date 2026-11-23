import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/current-user";
import { can } from "@/lib/auth/roles";
import { revokeSessionInvite } from "@/lib/live/invites";
import { clientIp } from "@/lib/request-ip";
import { withTenantRoute } from "@/lib/tenant/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Remove an invited guest: their link stops working and their view closes.
export const DELETE = withTenantRoute(async (req: Request, { params }: { params: Promise<{ sessionId: string; inviteId: string }> }) => {
  const admin = await getCurrentUser();
  if (!admin) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!can(admin.role, "configure")) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { sessionId, inviteId } = await params;
  const ok = await revokeSessionInvite(sessionId, inviteId, { id: admin.id, email: admin.email }, clientIp(req.headers) ?? null);
  return ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "not_found" }, { status: 404 });
});
