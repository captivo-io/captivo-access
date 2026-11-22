// Ticket rules, pure (no DB, no network) so routes, the cron and tests share
// them. A resource can ask for a ticket number on every grant ("required"), or
// also let an approved ticket stand in for an Access approval ("itsm"). The
// ticket system says what the ticket is; these rules say what that means.

export const TICKET_KINDS = ["none", "servicenow", "jira", "https"] as const;
export type TicketKind = (typeof TICKET_KINDS)[number];
export const TICKET_MODES = ["off", "required", "itsm"] as const;
export type TicketMode = (typeof TICKET_MODES)[number];

export const KIND_LABEL: Record<TicketKind, string> = {
  none: "Ticket numbers only",
  servicenow: "ServiceNow",
  jira: "Jira Service Management",
  https: "HTTPS endpoint",
};

export const MODE_LABEL: Record<TicketMode, string> = {
  off: "No ticket",
  required: "Ticket required",
  itsm: "Approved ticket is enough",
};

/** States that give access when the workspace has not listed its own. */
export const DEFAULT_STATES: Record<TicketKind, string[]> = {
  none: [],
  // Open states: a change is usable from New to Implement, an incident until it is resolved.
  servicenow: ["New", "Assess", "Authorize", "Scheduled", "Implement", "In Progress", "On Hold"],
  jira: ["Open", "Planning", "Awaiting approval", "Awaiting implementation", "Implementing", "In Progress", "Work in progress", "Pending", "Waiting for support"],
  https: [],
};

/** ServiceNow tables a number can be looked up in, and the prefix that names each. */
export const SERVICENOW_TABLES: { table: string; prefix: string; label: string }[] = [
  { table: "change_request", prefix: "CHG", label: "Change requests" },
  { table: "incident", prefix: "INC", label: "Incidents" },
  { table: "change_task", prefix: "CTASK", label: "Change tasks" },
  { table: "sc_req_item", prefix: "RITM", label: "Requested items" },
  { table: "sc_task", prefix: "SCTASK", label: "Catalog tasks" },
  { table: "problem", prefix: "PRB", label: "Problems" },
];

/** What a ticket system said about one ticket. */
export interface TicketFacts {
  ref: string;
  title: string | null;
  state: string | null;
  /** true: approved there; false: waiting or refused; null: it has no approval. */
  approved: boolean | null;
  /** Its approval was refused. */
  rejected?: boolean;
  start: Date | null;
  end: Date | null;
  /** E-mail of whoever it is assigned to, when the system shows it. */
  assignee: string | null;
  url: string | null;
  /** How to reach it again to add a note: ServiceNow's table and sys_id. */
  table?: string | null;
  sysId?: string | null;
  /** An HTTPS endpoint answers the question itself. */
  valid?: boolean;
  reason?: string | null;
}

/** The form a ticket is kept in on a grant (AccessGrant.ticket). */
export interface TicketSnapshot {
  system: TicketKind;
  title: string | null;
  state: string | null;
  approved: boolean | null;
  start: string | null;
  end: string | null;
  assignee: string | null;
  url: string | null;
  table: string | null;
  sysId: string | null;
  /** Set when the ticket could not be checked (the system did not answer). */
  error?: string | null;
}

export function snapshot(kind: TicketKind, f: TicketFacts | null, error?: string | null): TicketSnapshot {
  return {
    system: kind,
    title: f?.title ?? null,
    state: f?.state ?? null,
    approved: f?.approved ?? null,
    start: f?.start?.toISOString() ?? null,
    end: f?.end?.toISOString() ?? null,
    assignee: f?.assignee ?? null,
    url: f?.url ?? null,
    table: f?.table ?? null,
    sysId: f?.sysId ?? null,
    ...(error ? { error } : {}),
  };
}

export function readSnapshot(v: unknown): TicketSnapshot | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const s = (k: string) => (typeof o[k] === "string" ? (o[k] as string) : null);
  const system = TICKET_KINDS.includes(o.system as TicketKind) ? (o.system as TicketKind) : "none";
  return {
    system, title: s("title"), state: s("state"),
    approved: typeof o.approved === "boolean" ? o.approved : null,
    start: s("start"), end: s("end"), assignee: s("assignee"), url: s("url"), table: s("table"), sysId: s("sysId"),
    error: s("error"),
  };
}

/** A resource's own rule, else the workspace's. "itsm" needs a system that can say a ticket is approved. */
export function effectiveMode(siteMode: string | null | undefined, sys: { kind: string; defaultMode: string } | null): TicketMode {
  const raw = siteMode ?? sys?.defaultMode ?? "off";
  const mode: TicketMode = TICKET_MODES.includes(raw as TicketMode) ? (raw as TicketMode) : "off";
  if (mode === "itsm" && (!sys || sys.kind === "none")) return "required";
  return mode;
}

/**
 * A ticket number as typed, tidied: trimmed, and upper-cased where the system's
 * numbers are (CHG0030001, OPS-123). Null when it can't be one.
 */
export function normalizeRef(raw: unknown, kind: TicketKind): string | null {
  if (typeof raw !== "string") return null;
  let v = raw.trim();
  if (!v) return null;
  if (kind === "servicenow" || kind === "jira") v = v.toUpperCase();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,63}$/.test(v)) return null;
  if (kind === "jira" && !/^[A-Z][A-Z0-9_]*-\d+$/.test(v)) return null;
  return v;
}

/** ServiceNow tables to look a number up in: the one its prefix names, when that one is enabled. */
export function tablesFor(ref: string, enabled: string[]): string[] {
  const hit = [...SERVICENOW_TABLES].sort((a, b) => b.prefix.length - a.prefix.length).find((t) => ref.startsWith(t.prefix));
  if (hit) return enabled.includes(hit.table) ? [hit.table] : [];
  return enabled;
}

export type Refusal = "not_found" | "state" | "assignee" | "window_over" | "rejected";

export type Verdict = { ok: true; approved: boolean } | { ok: false; why: Refusal; detail: string | null };

/** Whether this ticket can give this person access now. */
export function verdict(
  f: TicketFacts | null,
  cfg: { kind: TicketKind; allowedStates: string[]; matchAssignee: boolean },
  who: { email: string },
  now = new Date(),
): Verdict {
  if (!f) return { ok: false, why: "not_found", detail: null };
  if (f.rejected) return { ok: false, why: "rejected", detail: "its approval was rejected" };
  if (cfg.kind === "https") {
    if (f.valid !== true) return { ok: false, why: "rejected", detail: f.reason ?? null };
  } else {
    const states = (cfg.allowedStates.length ? cfg.allowedStates : DEFAULT_STATES[cfg.kind]).map((s) => s.trim().toLowerCase());
    if (!f.state || !states.includes(f.state.trim().toLowerCase())) return { ok: false, why: "state", detail: f.state };
  }
  if (cfg.matchAssignee && (!f.assignee || f.assignee.toLowerCase() !== who.email.toLowerCase())) {
    return { ok: false, why: "assignee", detail: f.assignee };
  }
  if (f.end && f.end <= now) return { ok: false, why: "window_over", detail: f.end.toISOString() };
  return { ok: true, approved: f.approved === true };
}

/** Why a ticket was refused, for the person who typed it. */
export function refusalText(why: Refusal, detail: string | null, system: string): string {
  switch (why) {
    case "not_found": return `${system} has no ticket with that number.`;
    case "state": return detail ? `The ticket is "${detail}", a state that doesn't allow access.` : "The ticket is in a state that doesn't allow access.";
    case "assignee": return "The ticket isn't assigned to you.";
    case "window_over": return "The ticket's change window is over.";
    case "rejected": return detail ? `${system} refused it: ${detail}` : `${system} refused it.`;
  }
}

/**
 * Fits the asked-for time into the ticket's window: access starts no earlier
 * than the window opens and ends no later than it closes.
 */
export function clampToWindow(
  startsAt: Date | null,
  endsAt: Date | null,
  f: { start: Date | null; end: Date | null } | null,
  now = new Date(),
): { startsAt: Date | null; endsAt: Date | null; clamped: boolean } {
  let s = startsAt, e = endsAt, clamped = false;
  if (f?.start && f.start > (s ?? now)) { s = f.start; clamped = true; }
  if (f?.end && (!e || f.end < e)) { e = f.end; clamped = true; }
  return { startsAt: s, endsAt: e, clamped };
}

const NATIVE: Record<string, string> = {
  native_ssh: " with their own SSH client (not recorded)",
  native_rdp: " with their own Remote Desktop client (not recorded)",
  database: " (database)",
};

/** The work note added to a ticket for a session, from its audit reason ("session_open native_ssh", "session_close 42m"). */
export function noteText(input: {
  reason: string; who: string; email: string | null; site: string; at: Date; recordingsUrl: string | null;
}): { kind: "open" | "close"; body: string } | null {
  const [code, ...rest] = input.reason.trim().split(/\s+/);
  const extra = rest.join(" ");
  const when = input.at.toISOString().replace("T", " ").replace(/:\d\d\.\d+Z$/, " UTC");
  const who = input.email && input.email !== input.who ? `${input.who} (${input.email})` : input.who;
  if (code === "session_open") {
    const how = NATIVE[extra] ?? "";
    const unrecorded = extra === "native_ssh" || extra === "native_rdp";
    return {
      kind: "open",
      body: `Captivo Access: ${who} opened a session to ${input.site}${how} at ${when}.${input.recordingsUrl && !unrecorded ? ` Recordings: ${input.recordingsUrl}` : ""}`,
    };
  }
  if (code === "session_close") {
    return { kind: "close", body: `Captivo Access: ${who} closed the session to ${input.site} at ${when}${extra ? ` after ${extra}` : ""}.` };
  }
  return null;
}
