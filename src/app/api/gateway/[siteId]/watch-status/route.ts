import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/current-user";
import { getWatchStatus } from "@/lib/dataplane/client";
import { withTenantRoute } from "@/lib/tenant/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withTenantRoute(async (_req: Request, { params }: { params: Promise<{ siteId: string }> }) => {
  // 401, not a redirect to /login: the session page polls this and reads a
  // 401 as "signed out" (src/lib/session/end-reason.ts).
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { siteId } = await params;
  const status = await getWatchStatus(user.id, siteId);
  return NextResponse.json(status);
});
