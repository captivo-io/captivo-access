import { NextRequest, NextResponse } from "next/server";
import { appendAuditEvents, type AuditInput } from "@/lib/audit/append";
import { requireDataplaneSecret, resolveTenantBySite, resolveTenantByHostname } from "@/lib/tenant/internal";
import { withTenant } from "@/lib/tenant/scope";
import { multiTenantEnabled } from "@/lib/tenant/enabled";
import { noteSessionsClosed } from "@/lib/vault/rotation-pass";
import { deliverTicketNotes, queueSessionNotes } from "@/lib/ticketing/notes";

// Resources whose session just ended: password rotation may be due (lib/vault/rotation-pass.ts).
function closedSites(events: AuditInput[]): string[] {
  return events.filter((e) => e.siteId && e.reason?.startsWith("session_close")).map((e) => e.siteId!);
}

async function noteClosed(events: AuditInput[]): Promise<void> {
  const ids = closedSites(events);
  if (ids.length) await noteSessionsClosed(ids).catch((e) => console.error("vault: noting closed sessions failed", e));
}

/** Work notes for ticketed sessions: queued in the scope, sent after it (not awaited). */
async function noteTickets(events: AuditInput[]): Promise<boolean> {
  return (await queueSessionNotes(events).catch((e) => { console.error("ticketing: queueing notes failed", e); return 0; })) > 0;
}

function sendTicketNotes(tenantId: string | null): void {
  void deliverTicketNotes(tenantId).catch((e) => console.error("ticketing: sending notes failed", e));
}

// The hosted data-plane is shared across ALL tenants, so a single batch can
// interleave events from many of them — unlike the other internal/* endpoints
// (see internal.ts), this route is intentionally NOT wrapped in
// withTenantFrom (single resolved tenant for the whole request). Instead each
// event resolves its own tenant and the batch is grouped + appended per group,
// since the per-tenant audit chain (appendAuditEvents keys on
// currentTenantId()) requires each event to land under its own tenant.
async function resolveEventTenant(e: AuditInput): Promise<string | null> {
  if (e.siteId) {
    const tid = await resolveTenantBySite(e.siteId);
    if (tid) return tid;
  }
  if (e.host) return resolveTenantByHostname(e.host);
  return null;
}

async function handler(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { events?: AuditInput[] };
  const events = Array.isArray(body.events) ? body.events : [];

  // Flag off (self-host): a single implicit "default" tenant — collapse to the
  // prior behavior exactly, one append call for the whole batch, no per-event
  // resolution.
  if (!multiTenantEnabled()) {
    const inserted = await appendAuditEvents(events);
    await noteClosed(events);
    if (await noteTickets(events)) sendTicketNotes(null);
    return NextResponse.json({ inserted });
  }

  const groups = new Map<string, AuditInput[]>();
  let dropped = 0;
  for (const e of events) {
    const tid = await resolveEventTenant(e);
    if (!tid) {
      dropped++;
      continue;
    }
    const group = groups.get(tid);
    if (group) group.push(e);
    else groups.set(tid, [e]);
  }

  let inserted = 0;
  for (const [tid, group] of groups) {
    let notes = false;
    inserted += await withTenant(tid, async () => {
      const n = await appendAuditEvents(group);
      await noteClosed(group);
      notes = await noteTickets(group);
      return n;
    });
    if (notes) sendTicketNotes(tid);
  }

  return NextResponse.json({ inserted, dropped });
}

// requireDataplaneSecret is the outermost gate: an unauthenticated caller never
// reaches per-event tenant resolution (SECURITY DEFINER, RLS-bypass) or any DB
// work — closing the pre-auth enumeration oracle the other internal/* routes
// guard against (see internal.ts's requireDataplaneSecret doc comment).
export const POST = requireDataplaneSecret(handler);
