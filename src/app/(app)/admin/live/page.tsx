import { siteTile, SITE_TILE_SELECT } from "@/lib/access/grant-rows";
import { notFound } from "next/navigation";
import { getCurrentUser } from "@/lib/current-user";
import { can } from "@/lib/auth/roles";
import { db } from "@/lib/db";
import { liveRows } from "@/lib/live/rows";
import { workspaceView } from "@/lib/mobile/views";
import { AutoRefresh } from "@/app/(app)/_shell/auto-refresh";
import { withRequestTenant } from "@/lib/tenant/request";
import { SessionsView, type RecentRecording } from "./sessions-view";
import { canModerate } from "@/lib/moderation/rules";
import { waitingRequests } from "@/lib/moderation/requests";
import { resolvedModeratorRoles } from "@/lib/settings/platform";

export const dynamic = "force-dynamic";
export const metadata = { title: "Live sessions" };

async function AdminLivePageImpl({ searchParams }: { searchParams: Promise<{ watch?: string }> }) {
  const user = await getCurrentUser();
  if (!user || !can(user.role, "read_console")) notFound();
  const { watch } = await searchParams;
  const since = new Date(Date.now() - 86_400_000);
  const moderator = canModerate(user.role, await resolvedModeratorRoles());

  const [ws, rows, dayTotal, recent] = await Promise.all([
    workspaceView().catch(() => ({ name: "", slug: null as string | null })),
    liveRows(),
    // Sessions opened in the last day, as the audit log has them.
    db.auditEvent.count({ where: { timestamp: { gte: since }, reason: { startsWith: "session_open" } } }),
    can(user.role, "configure")
      ? db.sessionRecording.findMany({
          where: { purgePendingAt: null },
          orderBy: { lastEventAt: "desc" },
          take: 3,
          select: { id: true, siteId: true, userId: true, host: true, startedAt: true, lastEventAt: true, durationMs: true, format: true, protocol: true },
        })
      : Promise.resolve([]),
  ]);
  // A moderator never admits their own session.
  const waiting = moderator ? (await waitingRequests()).filter((r) => r.userId !== user.id) : [];
  const [users, sites] = await Promise.all([
    db.user.findMany({ where: { id: { in: recent.map((r) => r.userId) } }, select: { id: true, name: true, email: true } }),
    db.site.findMany({ where: { id: { in: recent.map((r) => r.siteId) } }, select: SITE_TILE_SELECT }),
  ]);
  const recentRows: RecentRecording[] = recent.map((r) => ({
    id: r.id,
    siteName: sites.find((s) => s.id === r.siteId)?.name ?? r.host,
    site: (() => { const s = sites.find((x) => x.id === r.siteId); return s ? siteTile(s) : undefined; })(),
    userLabel: users.find((u) => u.id === r.userId)?.name ?? users.find((u) => u.id === r.userId)?.email ?? "Unknown user",
    startedAt: r.startedAt.toISOString(),
    lengthMs: r.durationMs ?? Math.max(0, r.lastEventAt.getTime() - r.startedAt.getTime()),
    format: r.format,
    protocol: r.protocol,
  }));

  return (
    <main>
      <AutoRefresh intervalMs={5000} />
      <SessionsView
        rows={rows}
        dayTotal={dayTotal}
        recent={recentRows}
        workspace={ws.slug ?? ws.name ?? ""}
        canTerminate={can(user.role, "configure")}
        canReplay={can(user.role, "configure")}
        initialWatch={watch ?? null}
        waiting={waiting}
        canModerate={moderator}
        meId={user.id}
      />
    </main>
  );
}

export default async function AdminLivePage(...args: Parameters<typeof AdminLivePageImpl>) {
  return withRequestTenant(() => AdminLivePageImpl(...args));
}
