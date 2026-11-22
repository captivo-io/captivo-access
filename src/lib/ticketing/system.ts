import { db } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { decrypt } from "@/lib/crypto";
import { currentTenantId } from "@/lib/tenant/context";
import { lookupTicket, TicketSystemError, describeSystemError, type SystemSpec, type HttpsContext } from "./providers";
import {
  clampToWindow, effectiveMode, KIND_LABEL, normalizeRef, refusalText, snapshot, verdict,
  type TicketFacts, type TicketKind, type TicketMode, type TicketSnapshot,
} from "./rules";

// The workspace's ticket system as the routes use it: load it, check a ticket
// against it, and decide what a grant asked for with a ticket becomes.

export type TicketSystemRow = NonNullable<Awaited<ReturnType<typeof loadTicketSystem>>>;

export function loadTicketSystem() {
  return db.ticketSystem.findUnique({ where: { tenantId: currentTenantId() } });
}

export function systemSpec(s: TicketSystemRow): SystemSpec {
  return { kind: s.kind as TicketKind, baseUrl: s.baseUrl, username: s.username, tables: s.tables, startField: s.startField, endField: s.endField };
}

/** The stored secret in the clear; undefined when it can't be read (a changed ENCRYPTION_KEY). */
export function systemSecret(s: { secret: string | null }): string | null | undefined {
  if (!s.secret) return null;
  try {
    return decrypt(s.secret);
  } catch {
    return undefined;
  }
}

/** Whether tickets are looked up at all (a system other than "numbers only"). */
export function checksTickets(s: { kind: string; baseUrl: string | null } | null): s is TicketSystemRow {
  return !!s && s.kind !== "none" && !!s.baseUrl;
}

export function systemLabel(s: { kind: string } | null): string {
  return s && s.kind !== "none" && s.kind !== "https" ? KIND_LABEL[s.kind as TicketKind] : "the ticket system";
}

export type Lookup = { ok: true; facts: TicketFacts | null } | { ok: false; error: string; message: string };

/** One lookup, with the system's health written down for the Ticketing page. */
export async function lookup(s: TicketSystemRow, ref: string, ctx: HttpsContext): Promise<Lookup> {
  const secret = systemSecret(s);
  if (secret === undefined) return { ok: false, error: "secret_unreadable", message: "The saved password or token can't be read; enter it again." };
  try {
    const facts = await lookupTicket(systemSpec(s), secret, ref, ctx);
    await noteHealth(null);
    return { ok: true, facts };
  } catch (e) {
    const message = describeSystemError(e);
    await noteHealth(message);
    return { ok: false, error: e instanceof TicketSystemError ? e.reason : "error", message };
  }
}

export async function noteHealth(error: string | null): Promise<void> {
  const now = new Date();
  await db.ticketSystem.updateMany({
    where: { tenantId: currentTenantId() },
    data: error ? { lastError: error.slice(0, 300), lastErrorAt: now } : { lastOkAt: now, lastError: null },
  }).catch(() => undefined);
}

/** What goes on the grant. */
export interface GrantTicket {
  ticketRef: string;
  ticket: TicketSnapshot;
  ticketVerified: boolean;
  ticketCheckedAt: Date | null;
}

export type Gate =
  | { ok: false; status: number; error: string; message: string }
  | {
      ok: true;
      ticket: GrantTicket | null;
      /** Every resource takes an approved ticket as approval, and this one is approved. */
      approvedByTicket: boolean;
      /** Asked for, but the system could not be reached: a person has to decide. */
      unverified: boolean;
      startsAt: Date | null;
      endsAt: Date | null;
      clamped: boolean;
      system: string;
    };

/**
 * What a grant asked for on these resources, with this ticket number, comes
 * to: refused (no ticket where one is needed, or one the system says can't
 * give access), or allowed with the ticket recorded and the times fitted into
 * its window.
 */
export async function gateTicket(input: {
  ref: unknown;
  sites: { id: string; name: string; ticketMode: string | null }[];
  who: { email: string; name: string | null };
  startsAt: Date | null;
  endsAt: Date | null;
  workspace: string;
  now?: Date;
}): Promise<Gate> {
  const now = input.now ?? new Date();
  const sys = await loadTicketSystem();
  const kind = (sys?.kind ?? "none") as TicketKind;
  const modes: TicketMode[] = input.sites.map((s) => effectiveMode(s.ticketMode, sys));
  const needed = modes.some((m) => m !== "off");
  const typed = typeof input.ref === "string" && input.ref.trim() !== "";
  const ref = normalizeRef(input.ref, kind);
  const label = systemLabel(sys);
  const pass = { approvedByTicket: false, unverified: false, startsAt: input.startsAt, endsAt: input.endsAt, clamped: false, system: label };
  if (typed && !ref) return { ok: false, status: 400, error: "ticket_invalid", message: kind === "jira" ? "Enter a Jira key such as OPS-123." : "That doesn't look like a ticket number." };
  if (!ref) {
    if (needed) return { ok: false, status: 400, error: "ticket_required", message: "This resource needs a ticket number." };
    return { ok: true, ticket: null, ...pass };
  }
  if (!checksTickets(sys)) {
    return { ok: true, ticket: { ticketRef: ref, ticket: snapshot("none", null), ticketVerified: false, ticketCheckedAt: null }, ...pass };
  }
  const site = input.sites.length === 1 ? input.sites[0] : null;
  const r = await lookup(sys, ref, { user: input.who, resource: site ? { id: site.id, name: site.name } : null, workspace: input.workspace });
  if (!r.ok) {
    return {
      ok: true,
      ticket: { ticketRef: ref, ticket: snapshot(kind, null, r.message), ticketVerified: false, ticketCheckedAt: null },
      ...pass, unverified: true,
    };
  }
  const v = verdict(r.facts, { kind, allowedStates: sys.allowedStates, matchAssignee: sys.matchAssignee }, input.who, now);
  if (!v.ok) return { ok: false, status: 400, error: `ticket_${v.why}`, message: refusalText(v.why, v.detail, label) };
  const w = clampToWindow(input.startsAt, input.endsAt, r.facts, now);
  return {
    ok: true,
    ticket: { ticketRef: r.facts?.ref ?? ref, ticket: snapshot(kind, r.facts), ticketVerified: true, ticketCheckedAt: now },
    approvedByTicket: v.approved && modes.length > 0 && modes.every((m) => m === "itsm"),
    unverified: false,
    startsAt: w.startsAt, endsAt: w.endsAt, clamped: w.clamped,
    system: label,
  };
}

/** The grant columns for a ticket. */
export function grantTicketData(t: GrantTicket | null) {
  if (!t) return {};
  return { ticketRef: t.ticketRef, ticket: t.ticket as unknown as Prisma.InputJsonValue, ticketVerified: t.ticketVerified, ticketCheckedAt: t.ticketCheckedAt };
}
