import { requireCapability } from "@/lib/current-user";
import { GrantsIcon } from "@/components/icons";
import { can } from "@/lib/auth/roles";
import { db } from "@/lib/db";
import { listGrants, listPendingGrants } from "@/lib/access/grants";
import { classifyGrant } from "@/lib/access/evaluate";
import { parseSchedule, formatSchedule } from "@/lib/access/schedule";
import { LocalTime } from "@/app/(app)/_shell/local-time";
import { AddGrantButton } from "./add-grant-button";
import { TestAccessWidget } from "./test-access-widget";
import { DecisionButtons } from "./decision-buttons";
import { GrantsTable, type GrantRow } from "./grants-table";
import { withRequestTenant } from "@/lib/tenant/request";

export const dynamic = "force-dynamic";
export const metadata = { title: "Grants" };

async function AdminGrantsPageImpl({ searchParams }: { searchParams: Promise<{ new?: string }> }) {
  const openNew = (await searchParams).new === "1";
  const user = await requireCapability("read_console");
  const canApprove = can(user.role, "approve_grants");
  const canConfigure = can(user.role, "configure");

  const [users, sites, grants, pending] = await Promise.all([
    db.user.findMany({
      select: { id: true, name: true, email: true, role: true },
      orderBy: [{ role: "desc" }, { name: "asc" }], // connect-only roles (Vendor/Staff) first, Admin last
    }),
    db.site.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }),
    listGrants(),
    listPendingGrants(),
  ]);

  const now = new Date();
  const grantRows: GrantRow[] = grants.map((g) => {
    const s = parseSchedule(g.schedule);
    return {
      id: g.id,
      userName: g.user.name,
      userEmail: g.user.email,
      siteName: g.site.name,
      startsAt: g.startsAt ? g.startsAt.toISOString() : null,
      endsAt: g.endsAt ? g.endsAt.toISOString() : null,
      scheduleText: s ? formatSchedule(s) : null,
      note: g.note,
      reason: classifyGrant(g, now),
      denyReason: g.denyReason,
      active: g.status === "ACTIVE",
    };
  });

  return (
    <main>
      <div className="page-head">
        <div>
          <div className="page-title-row"><span className="page-icon"><GrantsIcon /></span><h1>Access grants</h1></div>
          <p>Grant a user time-boxed access to a resource. Leave the end date empty for permanent access.</p>
        </div>
        {canApprove && users.length > 0 && sites.length > 0 && <AddGrantButton users={users} sites={sites} initialOpen={openNew} />}
      </div>

      {pending.length > 0 && (
        <div className="card">
          <div className="card-head"><h2>Pending requests</h2></div>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>User</th><th>App</th><th>Requested window</th><th>Justification</th><th></th></tr></thead>
              <tbody>
                {pending.map((p) => (
                  <tr key={p.id}>
                    <td>{p.user.name}<div className="cell-sub">{p.user.email}</div></td>
                    <td>{p.site.name}</td>
                    <td className="cell-sub">
                      {p.startsAt ? <LocalTime iso={p.startsAt.toISOString()} /> : "Immediately"} → {p.endsAt ? <LocalTime iso={p.endsAt.toISOString()} /> : "Permanent"}
                      {(() => { const s = parseSchedule(p.schedule); return s ? <div>{formatSchedule(s)}</div> : null; })()}
                    </td>
                    <td className="cell-sub">{p.note ?? "—"}</td>
                    <td>{canApprove ? <DecisionButtons grantId={p.id} /> : <span className="cell-sub">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <h2>Grants</h2>
      {grants.length === 0 ? (
        <div className="empty">No grants yet.</div>
      ) : (
        <GrantsTable rows={grantRows} canApprove={canApprove} canConfigure={canConfigure} />
      )}

      {users.length > 0 && sites.length > 0 && <TestAccessWidget users={users} sites={sites} />}
    </main>
  );
}

export default async function AdminGrantsPage(...args: Parameters<typeof AdminGrantsPageImpl>) {
  return withRequestTenant(() => AdminGrantsPageImpl(...args));
}

