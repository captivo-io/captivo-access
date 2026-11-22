import { tenantFetch, PrivateAddressError } from "@/lib/net/guarded-fetch";
import { tablesFor, type TicketFacts, type TicketKind } from "./rules";

// The calls to a ticket system: look a ticket up, add a work note to it. Each
// is one bounded HTTPS request (two on Jira, which keeps approvals apart), so
// a lookup made inside a request's tenant scope stays well under its budget.

const TIMEOUT_MS = 8_000;

export interface SystemSpec {
  kind: TicketKind;
  baseUrl: string | null;
  username: string | null;
  tables: string[];
  startField: string | null;
  endField: string | null;
}

/** The ticket system could not be asked, or did not answer in a way we can read. */
export class TicketSystemError extends Error {
  constructor(readonly reason: string, readonly detail?: string) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = "TicketSystemError";
  }
}

/** Words for a failure, for the admin who set the system up. */
export function describeSystemError(e: unknown): string {
  if (!(e instanceof TicketSystemError)) return "Unexpected error.";
  const d = e.detail ? ` (${e.detail})` : "";
  switch (e.reason) {
    case "auth": return `The ticket system refused the account${d}. Check the user and the password or token.`;
    case "timeout": return "The ticket system did not answer within 8 seconds.";
    case "private_address": return "That address is on a private network, which Captivo Access Cloud can't reach.";
    case "unreachable": return `Could not reach the ticket system${d}.`;
    case "bad_answer": return `The ticket system answered with something we can't read${d}.`;
    case "not_configured": return "No ticket system is set up.";
    default: return `The ticket system answered ${e.reason.replace("http_", "HTTP ")}${d}.`;
  }
}

async function call(url: string, init: { method?: string; headers: Record<string, string>; body?: string }): Promise<Response> {
  try {
    return await tenantFetch(url, { ...init, timeoutMs: TIMEOUT_MS });
  } catch (e) {
    if (e instanceof PrivateAddressError) throw new TicketSystemError("private_address");
    if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) throw new TicketSystemError("timeout");
    throw new TicketSystemError("unreachable", e instanceof Error ? e.message.slice(0, 160) : undefined);
  }
}

async function failure(res: Response): Promise<TicketSystemError> {
  const text = (await res.text().catch(() => "")).replace(/\s+/g, " ").trim().slice(0, 160);
  if (res.status === 401 || res.status === 403) return new TicketSystemError("auth", `HTTP ${res.status}`);
  return new TicketSystemError(`http_${res.status}`, text || undefined);
}

async function json(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    throw new TicketSystemError("bad_answer", "not JSON");
  }
}

function basic(user: string | null, secret: string | null): string {
  return `Basic ${Buffer.from(`${user ?? ""}:${secret ?? ""}`).toString("base64")}`;
}

const base = (s: SystemSpec) => (s.baseUrl ?? "").replace(/\/+$/, "");

/** A date as the systems write them: ServiceNow "2026-11-22 10:00:00" (UTC), Jira "…+0000" or a bare day. */
export function parseSystemDate(v: unknown): Date | null {
  if (typeof v !== "string" || !v.trim()) return null;
  let s = v.trim();
  if (/^\d{4}-\d\d-\d\d \d\d:\d\d(:\d\d)?$/.test(s)) s = `${s.replace(" ", "T")}Z`;
  s = s.replace(/([+-]\d\d)(\d\d)$/, "$1:$2");
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

// ---- ServiceNow (Table API) -------------------------------------------------

type SnField = { value?: string; display_value?: string } | string | undefined;
const snValue = (f: SnField) => (typeof f === "string" ? f : f?.value ?? "");
const snDisplay = (f: SnField) => (typeof f === "string" ? f : f?.display_value ?? f?.value ?? "");

function snApproved(v: string): boolean | null {
  if (v === "approved") return true;
  if (v === "rejected" || v === "requested") return false;
  return null; // "not requested", "not_required", empty: no approval on this ticket
}

async function serviceNowLookup(s: SystemSpec, secret: string | null, ref: string): Promise<TicketFacts | null> {
  const fields = "sys_id,number,short_description,state,approval,start_date,end_date,assigned_to.email";
  for (const table of tablesFor(ref, s.tables)) {
    const q = new URLSearchParams({ sysparm_query: `number=${ref}`, sysparm_limit: "1", sysparm_display_value: "all", sysparm_fields: fields, sysparm_exclude_reference_link: "true" });
    const res = await call(`${base(s)}/api/now/table/${table}?${q}`, { headers: { accept: "application/json", authorization: basic(s.username, secret) } });
    if (res.status === 404) continue;
    if (!res.ok) throw await failure(res);
    const body = (await json(res)) as { result?: Record<string, SnField>[] };
    const row = Array.isArray(body.result) ? body.result[0] : undefined;
    if (!row) continue;
    const sysId = snValue(row.sys_id);
    return {
      ref, table, sysId,
      title: snDisplay(row.short_description) || null,
      state: snDisplay(row.state) || null,
      approved: snApproved(snValue(row.approval)),
      rejected: snValue(row.approval) === "rejected",
      start: parseSystemDate(snValue(row.start_date)),
      end: parseSystemDate(snValue(row.end_date)),
      assignee: snValue(row["assigned_to.email"]) || null,
      url: `${base(s)}/${table}.do?sys_id=${encodeURIComponent(sysId)}`,
    };
  }
  return null;
}

async function serviceNowNote(s: SystemSpec, secret: string | null, t: { table: string | null; sysId: string | null }, text: string): Promise<void> {
  if (!t.table || !t.sysId) throw new TicketSystemError("bad_answer", "the ticket's table is not known");
  const res = await call(`${base(s)}/api/now/table/${t.table}/${encodeURIComponent(t.sysId)}?sysparm_fields=sys_id`, {
    method: "PATCH",
    headers: { accept: "application/json", "content-type": "application/json", authorization: basic(s.username, secret) },
    body: JSON.stringify({ work_notes: text }),
  });
  if (!res.ok) throw await failure(res);
}

// ---- Jira (Cloud REST v3 + Service Management) ------------------------------

async function jiraApproval(s: SystemSpec, secret: string | null, ref: string): Promise<{ approved: boolean | null; rejected: boolean }> {
  const res = await call(`${base(s)}/rest/servicedeskapi/request/${encodeURIComponent(ref)}/approval`, { headers: { accept: "application/json", authorization: basic(s.username, secret) } }).catch(() => null);
  if (!res || !res.ok) return { approved: null, rejected: false }; // not a service desk request, or approvals not visible
  const body = (await res.json().catch(() => ({}))) as { values?: { finalDecision?: string }[] };
  const v = Array.isArray(body.values) ? body.values : [];
  if (!v.length) return { approved: null, rejected: false };
  if (v.some((a) => a.finalDecision === "declined")) return { approved: false, rejected: true };
  return { approved: v.every((a) => a.finalDecision === "approved"), rejected: false };
}

async function jiraLookup(s: SystemSpec, secret: string | null, ref: string): Promise<TicketFacts | null> {
  const fields = ["summary", "status", "assignee", s.startField, s.endField].filter(Boolean).join(",");
  const res = await call(`${base(s)}/rest/api/3/issue/${encodeURIComponent(ref)}?fields=${encodeURIComponent(fields)}`, { headers: { accept: "application/json", authorization: basic(s.username, secret) } });
  if (res.status === 404) return null;
  if (!res.ok) throw await failure(res);
  const body = (await json(res)) as { key?: string; fields?: Record<string, unknown> };
  const f = body.fields ?? {};
  const status = f.status as { name?: string } | undefined;
  const assignee = f.assignee as { emailAddress?: string } | null | undefined;
  const approval = await jiraApproval(s, secret, ref);
  return {
    ref: body.key ?? ref,
    title: typeof f.summary === "string" ? f.summary : null,
    state: status?.name ?? null,
    approved: approval.approved,
    rejected: approval.rejected,
    start: s.startField ? parseSystemDate(f[s.startField]) : null,
    end: s.endField ? parseSystemDate(f[s.endField]) : null,
    assignee: assignee?.emailAddress ?? null,
    url: `${base(s)}/browse/${encodeURIComponent(body.key ?? ref)}`,
  };
}

async function jiraNote(s: SystemSpec, secret: string | null, ref: string, text: string): Promise<void> {
  const res = await call(`${base(s)}/rest/api/3/issue/${encodeURIComponent(ref)}/comment`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", authorization: basic(s.username, secret) },
    body: JSON.stringify({
      body: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text }] }] },
      // An internal note on a service desk ticket, so the customer side doesn't see it.
      properties: [{ key: "sd.public.comment", value: { internal: true } }],
    }),
  });
  if (!res.ok) throw await failure(res);
}

// ---- HTTPS endpoint (the workspace's own service answers) -------------------

export interface HttpsContext { user: { email: string; name: string | null }; resource: { id: string; name: string } | null; workspace: string }

function httpsHeaders(secret: string | null): Record<string, string> {
  return { accept: "application/json", "content-type": "application/json", ...(secret ? { authorization: `Bearer ${secret}` } : {}) };
}

async function httpsLookup(s: SystemSpec, secret: string | null, ref: string, ctx: HttpsContext): Promise<TicketFacts | null> {
  const res = await call(s.baseUrl ?? "", { method: "POST", headers: httpsHeaders(secret), body: JSON.stringify({ event: "ticket.check", ticket: ref, ...ctx }) });
  if (res.status === 404) return null;
  if (!res.ok) throw await failure(res);
  const b = (await json(res)) as Record<string, unknown>;
  if (b.found === false) return null;
  if (typeof b.valid !== "boolean") throw new TicketSystemError("bad_answer", 'no "valid" field');
  const str = (k: string) => (typeof b[k] === "string" && b[k] ? (b[k] as string) : null);
  return {
    ref, valid: b.valid, reason: str("reason"),
    title: str("title"), state: str("state"),
    approved: typeof b.approved === "boolean" ? b.approved : null,
    start: parseSystemDate(b.startsAt), end: parseSystemDate(b.endsAt),
    assignee: str("assignee"), url: str("url"),
  };
}

async function httpsNote(s: SystemSpec, secret: string | null, ref: string, kind: string, text: string): Promise<void> {
  const res = await call(s.baseUrl ?? "", { method: "POST", headers: httpsHeaders(secret), body: JSON.stringify({ event: "ticket.note", ticket: ref, kind, text }) });
  if (!res.ok) throw await failure(res);
}

// ---- dispatch ---------------------------------------------------------------

export async function lookupTicket(s: SystemSpec, secret: string | null, ref: string, ctx: HttpsContext): Promise<TicketFacts | null> {
  if (!s.baseUrl) throw new TicketSystemError("not_configured");
  if (s.kind === "servicenow") return serviceNowLookup(s, secret, ref);
  if (s.kind === "jira") return jiraLookup(s, secret, ref);
  if (s.kind === "https") return httpsLookup(s, secret, ref, ctx);
  throw new TicketSystemError("not_configured");
}

export async function addTicketNote(
  s: SystemSpec, secret: string | null, t: { ref: string; table: string | null; sysId: string | null }, kind: string, text: string,
): Promise<void> {
  if (!s.baseUrl) throw new TicketSystemError("not_configured");
  if (s.kind === "servicenow") return serviceNowNote(s, secret, t, text);
  if (s.kind === "jira") return jiraNote(s, secret, t.ref, text);
  if (s.kind === "https") return httpsNote(s, secret, t.ref, kind, text);
  throw new TicketSystemError("not_configured");
}
