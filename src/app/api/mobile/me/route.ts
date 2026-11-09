import { countPendingGrants } from "@/lib/access/grants";
import { liveRows } from "@/lib/live/rows";
import { countAllLiveSessions } from "@/lib/dataplane/client";
import { platformAlerts } from "@/lib/platform/overview";
import { mobileJson, mobileRoute } from "@/lib/mobile/route";
import { userView, workspaceView } from "@/lib/mobile/views";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * The person, the workspace and the numbers the app opens with. A platform
 * operator gets the platform's: sessions across every workspace and the
 * console's alerts (the cheap pass, without the DNS/TLS probes).
 */
export const GET = mobileRoute(["read_console", "manage_tenants"], async (_req, { user }) => {
  if (user.role === "PLATFORM") {
    const [workspace, live, alerts] = await Promise.all([workspaceView(), countAllLiveSessions(), platformAlerts()]);
    return mobileJson({
      user: userView(user),
      workspace,
      counts: { pending: 0, live, sitesDown: 0 },
      platform: { alerts: alerts.filter((a) => a.level !== "info").length },
    });
  }
  const [workspace, pending, live, sitesDown] = await Promise.all([
    workspaceView(),
    countPendingGrants(),
    liveRows().then((r) => r.length),
    db.site.count({ where: { probeOk: false } }),
  ]);
  return mobileJson({ user: userView(user), workspace, counts: { pending, live, sitesDown } });
});
