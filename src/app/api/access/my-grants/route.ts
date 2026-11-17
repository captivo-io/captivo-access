import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/current-user";
import { listUserGrants } from "@/lib/access/grants";
import { classifyGrant } from "@/lib/access/evaluate";
import { withTenantRoute } from "@/lib/tenant/request";
import { isConsoleUser } from "@/lib/auth/roles";
import { workspaceView } from "@/lib/mobile/views";

export const dynamic = "force-dynamic";

// The signed-in user's currently-active grants, for the login "access-ready" step,
// with who signed in to which workspace (the step's facts table) and whether
// they land in the console or in My access.
// Wrapped so its DB work runs under the request's tenant scope in cloud
// (pass-through on self-host). First proof site for withTenantRoute.
export const GET = withTenantRoute(async () => {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const now = new Date();
  const grants = (await listUserGrants(user.id))
    .filter((g) => classifyGrant(g, now) === "allow")
    .map((g) => ({
      id: g.id,
      siteId: g.site.id,
      hostname: g.site.hostname ?? "",
      siteName: g.site.name,
      accessMode: g.site.accessMode as "TRANSPARENT" | "GATEWAY" | "ISOLATED",
      endsAt: g.endsAt ? g.endsAt.toISOString() : null,
      scheduled: g.schedule != null,
    }));

  const ws = await workspaceView().catch(() => null);
  return NextResponse.json({
    grants,
    account: user.email,
    workspace: ws ? ws.slug ?? ws.name : null,
    console: isConsoleUser(user.role),
  });
});
