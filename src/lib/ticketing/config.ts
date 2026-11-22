import { SERVICENOW_TABLES, TICKET_KINDS, TICKET_MODES, type TicketKind, type TicketMode } from "./rules";

// The Ticketing page's form to a TicketSystem row, pure so it can be tested.

export interface SystemData {
  kind: TicketKind;
  baseUrl: string | null;
  username: string | null;
  tables: string[];
  allowedStates: string[];
  matchAssignee: boolean;
  writeNotes: boolean;
  startField: string | null;
  endField: string | null;
  defaultMode: TicketMode;
}

export type Parsed = { ok: true; data: SystemData; secret: string | null } | { ok: false; error: string };

const FIELD = /^(customfield_\d{1,8}|[a-z][A-Za-z0-9_]{0,40})$/;

function str(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
}

export function parseSystem(body: Record<string, unknown>, opts: { cloud: boolean }): Parsed {
  const kind = body.kind as TicketKind;
  if (!TICKET_KINDS.includes(kind)) return { ok: false, error: "invalid_kind" };
  const defaultMode = (body.defaultMode ?? "off") as TicketMode;
  if (!TICKET_MODES.includes(defaultMode)) return { ok: false, error: "invalid_mode" };
  const states = Array.isArray(body.allowedStates)
    ? [...new Set(body.allowedStates.map((s) => str(s, 60)).filter((s): s is string => !!s))].slice(0, 30)
    : [];
  const common = {
    matchAssignee: body.matchAssignee === true,
    writeNotes: body.writeNotes !== false,
    defaultMode: kind === "none" && defaultMode === "itsm" ? "required" as const : defaultMode,
  };
  if (kind === "none") {
    return { ok: true, secret: null, data: { kind, baseUrl: null, username: null, tables: ["change_request", "incident"], allowedStates: [], startField: null, endField: null, ...common, matchAssignee: false, writeNotes: false } };
  }
  const raw = str(body.baseUrl, 500);
  if (!raw) return { ok: false, error: "url_required" };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, error: "invalid_url" };
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && !opts.cloud)) return { ok: false, error: "https_required" };
  if (url.username || url.password) return { ok: false, error: "invalid_url" };
  // ServiceNow and Jira are addressed by their root; an HTTPS endpoint by its full URL.
  const baseUrl = kind === "https" ? url.toString() : `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  const username = kind === "https" ? null : str(body.username, 200);
  if (kind !== "https" && !username) return { ok: false, error: "username_required" };
  const known = SERVICENOW_TABLES.map((t) => t.table);
  const tables = kind === "servicenow"
    ? (Array.isArray(body.tables) ? body.tables : []).filter((t): t is string => typeof t === "string" && known.includes(t))
    : ["change_request", "incident"];
  if (kind === "servicenow" && tables.length === 0) return { ok: false, error: "tables_required" };
  const startField = kind === "jira" ? str(body.startField, 60) : null;
  const endField = kind === "jira" ? str(body.endField, 60) : null;
  if ((startField && !FIELD.test(startField)) || (endField && !FIELD.test(endField))) return { ok: false, error: "invalid_field" };
  const secret = typeof body.secret === "string" && body.secret !== "" ? body.secret.slice(0, 2000) : null;
  return {
    ok: true, secret,
    data: { kind, baseUrl, username, tables: [...new Set(tables)], allowedStates: kind === "https" ? [] : states, startField, endField, ...common },
  };
}

/** A password or token is needed, unless one is kept from before (same kind, same address). */
export function secretRequired(kind: TicketKind): boolean {
  return kind === "servicenow" || kind === "jira";
}

export const CONFIG_ERROR: Record<string, string> = {
  invalid_kind: "Choose a ticket system.",
  invalid_mode: "Choose what resources ask for.",
  url_required: "Enter the address.",
  invalid_url: "That address isn't valid.",
  https_required: "The address must start with https://.",
  username_required: "Enter the user (ServiceNow) or the account e-mail (Jira).",
  tables_required: "Choose at least one kind of ticket.",
  invalid_field: "A field id looks like customfield_10015.",
  secret_required: "Enter the password or API token.",
};
