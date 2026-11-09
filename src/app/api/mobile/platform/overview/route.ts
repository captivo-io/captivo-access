import { countAllLiveSessions } from "@/lib/dataplane/client";
import { platformSnapshot } from "@/lib/platform/overview";
import { mobileJson, mobileRoute } from "@/lib/mobile/route";
import { alertView } from "@/lib/mobile/platform";

export const dynamic = "force-dynamic";

/** The platform console's overview: totals, live sessions everywhere, alerts. */
export const GET = mobileRoute("manage_tenants", async () => {
  const [{ totals, alerts }, live] = await Promise.all([platformSnapshot(), countAllLiveSessions()]);
  return mobileJson({
    totals: {
      tenants: totals.tenants, active: totals.active, suspended: totals.suspended,
      users: totals.users, vendors: totals.vendors, sites: totals.sites,
      connectors: totals.connectors, connectorsOnline: totals.connectorsOnline,
      sessions24h: totals.sessions24h, requestsPending: totals.requestsPending, grantsActive: totals.grantsActive,
    },
    live,
    alerts: alerts.map(alertView),
  });
});
