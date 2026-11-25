import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/current-user";
import { SESSION_COOKIE } from "@/lib/auth/session";
import { SUPPORT_COOKIE } from "@/lib/support/session";
import { sha256 } from "@/lib/auth/tokens";
import { issueDbTicket } from "@/lib/database/issue";
import { withTenantRoute } from "@/lib/tenant/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Connection details for the signed-in user's own database client
// (lib/database/issue.ts). Each click makes a new ticket; earlier ones keep
// working until they end.
export const POST = withTenantRoute(async (req: Request, ctx: { params: Promise<{ siteId: string }> }) => {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const c = await cookies();
  const token = c.get(SUPPORT_COOKIE)?.value || c.get(SESSION_COOKIE)?.value || "";
  const session = token ? await db.session.findFirst({ where: { tokenHash: sha256(token) }, select: { id: true, expiresAt: true } }) : null;
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { siteId } = await ctx.params;
  const r = await issueDbTicket(user, session, siteId, req);
  return NextResponse.json(r.body, { status: r.status, headers: { "cache-control": "no-store" } });
});
