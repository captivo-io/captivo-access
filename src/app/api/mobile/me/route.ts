import { countPendingGrants } from "@/lib/access/grants";
import { liveRows } from "@/lib/live/rows";
import { mobileJson, mobileRoute } from "@/lib/mobile/route";
import { userView, workspaceView } from "@/lib/mobile/views";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/** The person, the workspace and the three numbers the app's Access screen opens with. */
export const GET = mobileRoute("read_console", async (_req, { user }) => {
  const [workspace, pending, live, sitesDown] = await Promise.all([
    workspaceView(),
    countPendingGrants(),
    liveRows().then((r) => r.length),
    db.site.count({ where: { probeOk: false } }),
  ]);
  return mobileJson({ user: userView(user), workspace, counts: { pending, live, sitesDown } });
});
