import { siteTile, SITE_TILE_SELECT } from "@/lib/access/grant-rows";
import { requireAdmin } from "@/lib/current-user";
import { db } from "@/lib/db";
import { listRecordings } from "@/lib/recording/query";
import { recordingKpis } from "@/lib/recording/kpis";
import { resolvedRecordingRetentionDays } from "@/lib/settings/platform";
import { workspaceView } from "@/lib/mobile/views";
import { RecordingsTable, type RecordingRowJSON } from "./recordings-table";
import { withRequestTenant } from "@/lib/tenant/request";

export const dynamic = "force-dynamic";
export const metadata = { title: "Recordings" };

async function AdminRecordingsPageImpl() {
  await requireAdmin();

  const [ws, users, sites, { rows, total }, kpis, retention] = await Promise.all([
    workspaceView().catch(() => ({ name: "", slug: null as string | null })),
    db.user.findMany({ select: { id: true, name: true, email: true }, orderBy: { name: "asc" } }),
    db.site.findMany({ select: SITE_TILE_SELECT, orderBy: { name: "asc" } }),
    listRecordings({ limit: 48, offset: 0 }),
    recordingKpis(),
    resolvedRecordingRetentionDays(),
  ]);

  const userMap = new Map(users.map((u) => [u.id, u]));
  const siteMap = new Map(sites.map((s) => [s.id, s]));
  const initialRows: RecordingRowJSON[] = rows.map((r) => ({
    id: r.id,
    startedAt: r.startedAt.toISOString(),
    lastEventAt: r.lastEventAt.toISOString(),
    durationMs: r.durationMs,
    host: r.host,
    bytes: r.bytes,
    userId: r.userId,
    userName: userMap.get(r.userId)?.name ?? null,
    userEmail: userMap.get(r.userId)?.email ?? null,
    siteId: r.siteId,
    siteName: siteMap.get(r.siteId)?.name ?? null,
    site: siteMap.has(r.siteId) ? siteTile(siteMap.get(r.siteId)!) : null,
    format: r.format,
    protocol: r.protocol,
    truncated: r.truncated,
    purgePending: r.purgePendingAt !== null,
    videoReady: r.videoReady,
    ticketRef: r.ticketRef,
  }));

  return (
    <main>
      <div className="page-head">
        <div>
          <div className="eyebrow"><span className="rec-dot" aria-hidden="true" />Operate{ws.slug ? ` · ${ws.slug}` : ""}</div>
          <h1>Recordings</h1>
          <p>Replay vendor and admin sessions on recorded resources, and search the commands typed in them.</p>
        </div>
        <div className="row-actions">
          <span className="rc-retention" title="Recordings older than this are removed by their connector">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
            Retention: {retention > 0 ? `${retention} days` : "kept until erased"}
          </span>
        </div>
      </div>
      <RecordingsTable users={users} initialRows={initialRows} initialTotal={total} kpis={kpis} />
    </main>
  );
}

export default async function AdminRecordingsPage(...args: Parameters<typeof AdminRecordingsPageImpl>) {
  return withRequestTenant(() => AdminRecordingsPageImpl(...args));
}
