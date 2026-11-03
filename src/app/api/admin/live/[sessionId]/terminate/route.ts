import { NextResponse } from "next/server";
import { requireUser } from "@/lib/current-user";
import { can } from "@/lib/auth/roles";
import { terminateLiveSession } from "@/lib/live/terminate";
import { clientIp } from "@/lib/request-ip";
import { withTenantRoute } from "@/lib/tenant/request";

export const POST = withTenantRoute(async (req: Request, ctx: { params: Promise<{ sessionId: string }> }) => {
  const admin = await requireUser();
  if (!can(admin.role, "configure")) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { sessionId } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as { grantId?: string };
  const grantId = typeof body.grantId === "string" && body.grantId ? body.grantId : null;
  return NextResponse.json(await terminateLiveSession({
    actor: { id: admin.id, email: admin.email },
    sessionId,
    grantId,
    clientIp: clientIp(req.headers) ?? null,
  }));
});
