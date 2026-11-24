import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/current-user";
import { can } from "@/lib/auth/roles";
import { createSessionInvite, invitesUnavailable, listSessionInvites } from "@/lib/live/invites";
import { isInviteDuration } from "@/lib/live/invite-token";
import { managerBaseUrl } from "@/lib/url";
import { clientIp } from "@/lib/request-ip";
import { withTenantRoute } from "@/lib/tenant/request";
import { SLOW_SCOPE_BUDGET_MS } from "@/lib/tenant/scope";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ sessionId: string }> };

// The people invited into a live session, and inviting one more. Admins only:
// an invite can hand control of the session to someone from outside.
export const GET = withTenantRoute(async (_req: NextRequest, { params }: Ctx) => {
  const admin = await getCurrentUser();
  if (!admin) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!can(admin.role, "configure")) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { sessionId } = await params;
  return NextResponse.json({ invites: await listSessionInvites(sessionId), unavailable: await invitesUnavailable() });
});

export const POST = withTenantRoute(async (req: NextRequest, { params }: Ctx) => {
  const admin = await getCurrentUser();
  if (!admin) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!can(admin.role, "configure")) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { sessionId } = await params;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const duration = isInviteDuration(body.duration) ? body.duration : "1h";
  const r = await createSessionInvite({
    sessionId,
    email: typeof body.email === "string" ? body.email : "",
    canControl: body.canControl === true,
    duration,
    actor: { id: admin.id, email: admin.email },
    baseUrl: managerBaseUrl(req),
    clientIp: clientIp(req.headers) ?? null,
  });
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.error === "not_found" ? 404 : 409 });
  return NextResponse.json(r);
}, { budgetMs: SLOW_SCOPE_BUDGET_MS });
