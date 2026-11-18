import { requireCapability } from "@/lib/current-user";
import { can } from "@/lib/auth/roles";
import { db } from "@/lib/db";
import { workspaceView } from "@/lib/mobile/views";
import { siteTile, SITE_TILE_SELECT, type SiteTile } from "@/lib/access/grant-rows";
import { pairIncidents } from "@/lib/notifications/incidents";
import { NotificationsView } from "./notifications-view";
import { withRequestTenant } from "@/lib/tenant/request";

export const dynamic = "force-dynamic";
export const metadata = { title: "Notifications" };

// Enough for weeks of a flapping resource; older rows stay in the database.
const ROWS = 2000;

async function AdminNotificationsPageImpl() {
  const user = await requireCapability("read_console");

  const [rows, unreachable, ws] = await Promise.all([
    db.notification.findMany({
      orderBy: { createdAt: "desc" },
      take: ROWS,
      select: { id: true, type: true, siteId: true, siteName: true, detail: true, createdAt: true, readAt: true },
    }),
    db.site.count({ where: { probeOk: false } }),
    workspaceView().catch(() => ({ name: "", slug: null as string | null })),
  ]);
  const incidents = pairIncidents(rows);
  const siteIds = [...new Set(incidents.map((i) => i.siteId).filter((x): x is string => !!x))];
  const sites = siteIds.length ? await db.site.findMany({ where: { id: { in: siteIds } }, select: SITE_TILE_SELECT }) : [];
  const tiles: Record<string, SiteTile> = Object.fromEntries(sites.map((s) => [s.id, siteTile(s)]));

  return (
    <main>
      <NotificationsView
        incidents={incidents}
        tiles={tiles}
        unreachable={unreachable}
        workspace={ws.slug}
        canTest={can(user.role, "configure")}
        serverNow={Date.now()}
      />
    </main>
  );
}

export default async function AdminNotificationsPage(...args: Parameters<typeof AdminNotificationsPageImpl>) {
  return withRequestTenant(() => AdminNotificationsPageImpl(...args));
}
