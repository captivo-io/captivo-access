import { NextResponse } from "next/server";
import { requireUser } from "@/lib/current-user";
import { can } from "@/lib/auth/roles";
import { getSessionFeed } from "@/lib/dataplane/client";
import { withTenantRoute } from "@/lib/tenant/request";

export const dynamic = "force-dynamic";

/** A live session's recent events for the watch panel; 404 once it has ended, 502 if the data plane did not answer. */
export const GET = withTenantRoute(async (_req: Request, ctx: { params: Promise<{ sessionId: string }> }) => {
  const admin = await requireUser();
  if (!can(admin.role, "read_console")) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { sessionId } = await ctx.params;
  const events = await getSessionFeed(sessionId);
  if (events === null) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (events === "unavailable") return NextResponse.json({ error: "unavailable" }, { status: 502 });
  return NextResponse.json({ events }, { headers: { "Cache-Control": "no-store" } });
});
