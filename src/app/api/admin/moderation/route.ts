import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/current-user";
import { canModerate } from "@/lib/moderation/rules";
import { waitingRequests } from "@/lib/moderation/requests";
import { resolvedModeratorRoles } from "@/lib/settings/platform";
import { withTenantRoute } from "@/lib/tenant/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Sessions waiting for a moderator, for someone who may moderate (others get none). */
export const GET = withTenantRoute(async () => {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!canModerate(user.role, await resolvedModeratorRoles())) return NextResponse.json({ requests: [] });
  const requests = (await waitingRequests()).filter((r) => r.userId !== user.id);
  return NextResponse.json({ requests }, { headers: { "cache-control": "no-store" } });
});
