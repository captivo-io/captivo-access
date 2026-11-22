import { requireCapability } from "@/lib/current-user";
import { can } from "@/lib/auth/roles";
import { db } from "@/lib/db";
import { listPendingGrants } from "@/lib/access/grants";
import { parseSchedule, formatSchedule } from "@/lib/access/schedule";
import { grantRows, siteTile, SITE_TILE_SELECT } from "@/lib/access/grant-rows";
import { GRANT_FILTERS, type GrantFilter } from "@/lib/access/grant-view";
import { resolvedMaxGrantDays } from "@/lib/settings/platform";
import { workspaceView } from "@/lib/mobile/views";
import { LocalTime } from "@/app/(app)/_shell/local-time";
import { DecisionButtons } from "./decision-buttons";
import { GrantsView } from "./grants-view";
import { withRequestTenant } from "@/lib/tenant/request";
import { TicketChip } from "@/app/(app)/_shell/ticket-chip";
import { checksTickets, loadTicketSystem, systemLabel } from "@/lib/ticketing/system";
import { effectiveMode } from "@/lib/ticketing/rules";
import type { GrantTickets } from "./grant-dialog";

export const dynamic = "force-dynamic";
export const metadata = { title: "Grants" };

async function AdminGrantsPageImpl({ searchParams }: { searchParams: Promise<{ new?: string; status?: string; user?: string }> }) {
  const sp = await searchParams;
  const user = await requireCapability("read_console");
  const canApprove = can(user.role, "approve_grants");
  const canConfigure = can(user.role, "configure");
  const now = new Date();

  const [ws, users, sites, rows, pending, maxGrantDays, ticketSys, ticketModes] = await Promise.all([
    workspaceView().catch(() => ({ name: "", slug: null as string | null })),
    db.user.findMany({
      select: { id: true, name: true, email: true, role: true, company: true, status: true },
      orderBy: [{ role: "desc" }, { name: "asc" }], // connect-only roles (Vendor/Staff) first, Admin last
    }),
    db.site.findMany({ select: SITE_TILE_SELECT, orderBy: { name: "asc" } }),
    grantRows(now),
    listPendingGrants(),
    resolvedMaxGrantDays(),
    loadTicketSystem(),
    db.site.findMany({ select: { id: true, ticketMode: true } }),
  ]);
  const tickets: GrantTickets = {
    modes: Object.fromEntries(ticketModes.map((s) => [s.id, effectiveMode(s.ticketMode, ticketSys)])),
    system: systemLabel(ticketSys),
    kind: ticketSys?.kind ?? "none",
    checked: checksTickets(ticketSys),
  };
  const tiles = sites.map(siteTile);
  const initialFilter: GrantFilter = GRANT_FILTERS.includes(sp.status as GrantFilter) ? (sp.status as GrantFilter) : "all";

  const head = (
    <div>
      <div className="eyebrow">Operate{ws.slug ? ` · ${ws.slug}` : ""}</div>
      <h1>Grants</h1>
      <p>Give users time-boxed or permanent access to resources. Every grant is logged and can be revoked at any moment.</p>
    </div>
  );
  const pendingCard = pending.length > 0 && (
    <section className="gr-pending">
      <div className="gr-pending-head"><b>Requests waiting for a decision</b><span className="mono t-muted">{pending.length}</span></div>
      {pending.map((p) => {
        const s = parseSchedule(p.schedule);
        return (
          <div key={p.id} className="gr-pending-row">
            <span className="gr-pending-who"><b>{p.user.name}</b><span className="mono t-muted">{p.user.email}</span></span>
            <span className="gr-pending-what">
              <b>{p.site.name}{p.ticketRef && <> <TicketChip ticketRef={p.ticketRef} ticket={p.ticket} verified={p.ticketVerified} /></>}</b>
              <span className="cell-sub">
                {p.startsAt ? <LocalTime iso={p.startsAt.toISOString()} /> : "Now"} → {p.endsAt ? <LocalTime iso={p.endsAt.toISOString()} /> : "Permanent"}
                {s && <> · {formatSchedule(s)}</>}
              </span>
            </span>
            <span className="gr-pending-why">{p.note ?? "—"}</span>
            {canApprove ? <DecisionButtons grantId={p.id} /> : <span className="cell-sub">Awaiting an approver</span>}
          </div>
        );
      })}
    </section>
  );

  return (
    <main>
      <GrantsView
        head={head}
        pending={pendingCard || null}
        rows={rows}
        users={users}
        sites={tiles}
        canApprove={canApprove}
        canConfigure={canConfigure}
        maxGrantDays={maxGrantDays}
        serverNow={now.getTime()}
        initialFilter={initialFilter}
        openNew={sp.new === "1"}
        openUser={typeof sp.user === "string" ? sp.user : null}
        tickets={tickets}
      />
    </main>
  );
}

export default async function AdminGrantsPage(...args: Parameters<typeof AdminGrantsPageImpl>) {
  return withRequestTenant(() => AdminGrantsPageImpl(...args));
}
