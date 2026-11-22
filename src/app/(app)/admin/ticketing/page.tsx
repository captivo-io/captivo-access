import { requireAdmin } from "@/lib/current-user";
import { db } from "@/lib/db";
import { currentTenantId } from "@/lib/tenant/context";
import { multiTenantEnabled } from "@/lib/tenant/enabled";
import { workspaceView } from "@/lib/mobile/views";
import { withRequestTenant } from "@/lib/tenant/request";
import { DEFAULT_STATES, type TicketKind, type TicketMode } from "@/lib/ticketing/rules";
import { Ticketing, type SystemView, type ResourceRow } from "./ticketing";

export const dynamic = "force-dynamic";
export const metadata = { title: "Ticketing" };

async function TicketingPageImpl() {
  await requireAdmin();
  const now = new Date();
  const live = { status: "ACTIVE" as const, directoryManaged: false, OR: [{ endsAt: null }, { endsAt: { gt: now } }] };
  const [sys, sites, withTicket, without, notesSent, ws] = await Promise.all([
    db.ticketSystem.findUnique({ where: { tenantId: currentTenantId() } }),
    db.site.findMany({ select: { id: true, name: true, accessMode: true, ticketMode: true, hostname: true }, orderBy: { name: "asc" } }),
    db.accessGrant.groupBy({ by: ["siteId"], where: { ...live, ticketRef: { not: null } }, _count: { _all: true } }),
    db.accessGrant.groupBy({ by: ["siteId"], where: { ...live, ticketRef: null }, _count: { _all: true } }),
    db.ticketNote.count({ where: { sentAt: { gt: new Date(now.getTime() - 7 * 86_400_000) } } }),
    workspaceView().catch(() => ({ slug: null as string | null })),
  ]);
  const count = (rows: { siteId: string; _count: { _all: number } }[], id: string) => rows.find((r) => r.siteId === id)?._count._all ?? 0;
  const failedNotes = await db.ticketNote.count({ where: { sentAt: null, attempts: { gt: 0 } } });
  const kind = (sys?.kind ?? "none") as TicketKind;
  const system: SystemView = {
    kind,
    baseUrl: sys?.baseUrl ?? "",
    username: sys?.username ?? "",
    hasSecret: !!sys?.secret,
    tables: sys?.tables ?? ["change_request", "incident"],
    allowedStates: sys?.allowedStates.length ? sys.allowedStates : DEFAULT_STATES[kind],
    matchAssignee: sys?.matchAssignee ?? false,
    writeNotes: sys?.writeNotes ?? true,
    startField: sys?.startField ?? "",
    endField: sys?.endField ?? "",
    defaultMode: (sys?.defaultMode ?? "off") as TicketMode,
    lastOkAt: sys?.lastOkAt?.toISOString() ?? null,
    lastError: sys?.lastError ?? null,
    lastErrorAt: sys?.lastErrorAt?.toISOString() ?? null,
    saved: !!sys,
  };
  const resources: ResourceRow[] = sites.map((s) => ({
    id: s.id, name: s.name, hostname: s.hostname, accessMode: s.accessMode,
    mode: (s.ticketMode ?? null) as TicketMode | null,
    withTicket: count(withTicket, s.id), withoutTicket: count(without, s.id),
  }));
  return (
    <main>
      <div className="page-head">
        <div>
          <div className="eyebrow">Platform{ws.slug ? ` · ${ws.slug}` : ""}</div>
          <h1>Ticketing</h1>
          <p>Tie access to a change or an incident: a ticket number on every grant, checked in your ticket system, with access that ends when the ticket closes.</p>
        </div>
      </div>
      <Ticketing system={system} resources={resources} cloud={multiTenantEnabled()} notes={{ sent: notesSent, failing: failedNotes }} />
    </main>
  );
}

export default async function TicketingPage(...args: Parameters<typeof TicketingPageImpl>) {
  return withRequestTenant(() => TicketingPageImpl(...args));
}
