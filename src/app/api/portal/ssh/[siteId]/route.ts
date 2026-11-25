import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/current-user";
import { issueSshTicket } from "@/lib/gateway/native-ssh-issue";
import { withTenantRoute } from "@/lib/tenant/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// A command for the signed-in user's own SSH client (lib/gateway/native-ssh-issue.ts).
export const POST = withTenantRoute(async (req: Request, ctx: { params: Promise<{ siteId: string }> }) => {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { siteId } = await ctx.params;
  const r = await issueSshTicket(user, siteId, req);
  return NextResponse.json(r.body, { status: r.status, headers: { "cache-control": "no-store" } });
});
