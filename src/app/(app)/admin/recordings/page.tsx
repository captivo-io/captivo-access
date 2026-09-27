import { requireAdmin } from "@/lib/current-user";
import { RecordingsIcon } from "@/components/icons";
import { db } from "@/lib/db";
import { listRecordings } from "@/lib/recording/query";
import { RecordingsTable, type RecordingRowJSON } from "./recordings-table";
import { withRequestTenant } from "@/lib/tenant/request";

export const dynamic = "force-dynamic";
export const metadata = { title: "Recordings" };

async function AdminRecordingsPageImpl() {
  await requireAdmin();

  const [users, sites, { rows, total }] = await Promise.all([
    db.user.findMany({ select: { id: true, name: true, email: true }, orderBy: { name: "asc" } }),
    db.site.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }),
    listRecordings({ limit: 50, offset: 0 }),
  ]);

  const userMap = new Map(users.map((u) => [u.id, u]));
  const siteMap = new Map(sites.map((s) => [s.id, s]));
  const initialRows: RecordingRowJSON[] = rows.map((r) => ({
    id: r.id,
    startedAt: r.startedAt.toISOString(),
    lastEventAt: r.lastEventAt.toISOString(),
    host: r.host,
    bytes: r.bytes,
    userId: r.userId,
    userName: userMap.get(r.userId)?.name ?? null,
    userEmail: userMap.get(r.userId)?.email ?? null,
    siteId: r.siteId,
    siteName: siteMap.get(r.siteId)?.name ?? null,
    format: r.format,
    protocol: r.protocol,
  }));

  return (
    <main>
      <div className="page-head">
        <div>
          <div className="page-title-row"><span className="page-icon"><RecordingsIcon /></span><h1>Recordings</h1></div>
          <p>Replay captured vendor sessions on recorded resources.</p>
        </div>
      </div>
      <RecordingsTable users={users} sites={sites} initialRows={initialRows} initialTotal={total} />
    </main>
  );
}

export default async function AdminRecordingsPage(...args: Parameters<typeof AdminRecordingsPageImpl>) {
  return withRequestTenant(() => AdminRecordingsPageImpl(...args));
}

