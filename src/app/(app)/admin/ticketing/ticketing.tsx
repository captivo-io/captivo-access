"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { LocalTime } from "../../_shell/local-time";
import { DEFAULT_STATES, KIND_LABEL, MODE_LABEL, SERVICENOW_TABLES, type TicketKind, type TicketMode } from "@/lib/ticketing/rules";

export type SystemView = {
  kind: TicketKind; baseUrl: string; username: string; hasSecret: boolean; tables: string[]; allowedStates: string[];
  matchAssignee: boolean; writeNotes: boolean; startField: string; endField: string; defaultMode: TicketMode;
  lastOkAt: string | null; lastError: string | null; lastErrorAt: string | null; saved: boolean;
};
export type ResourceRow = {
  id: string; name: string; hostname: string | null; accessMode: string; mode: TicketMode | null; withTicket: number; withoutTicket: number;
};

const KIND_SUB: Record<TicketKind, string> = {
  none: "recorded, not checked",
  servicenow: "changes, incidents",
  jira: "Cloud, Service Management",
  https: "your own service",
};
const KIND_TILE: Record<TicketKind, string> = { none: "#", servicenow: "SN", jira: "JSM", https: "API" };
const MODE_SUB: Record<TicketMode, string> = {
  off: "Grants need no ticket.",
  required: "Every request and grant names a ticket; an approver still decides.",
  itsm: "A ticket approved in the ticket system opens access at once; otherwise an approver decides.",
};
const TYPE: Record<string, string> = { TRANSPARENT: "Web app", ISOLATED: "Isolated", GATEWAY: "Remote", DATABASE: "Database" };

type Form = Omit<SystemView, "lastOkAt" | "lastError" | "lastErrorAt" | "saved" | "hasSecret"> & { secret: string };
type Found = {
  ok: boolean; message?: string; latencyMs?: number; found?: boolean; as?: string;
  ticket?: { ref: string; title: string | null; state: string | null; approved: boolean | null; rejected: boolean; start: string | null; end: string | null; assignee: string | null; url: string | null } | null;
  verdict?: { ok: true; approved: boolean } | { ok: false; message: string };
};

export function Ticketing({ system, resources, cloud, notes }: { system: SystemView; resources: ResourceRow[]; cloud: boolean; notes: { sent: number; failing: number } }) {
  return (
    <div className="tk-page">
      <Editor system={system} cloud={cloud} notes={notes} />
      <Resources rows={resources} system={system} />
    </div>
  );
}

function Editor({ system, cloud, notes }: { system: SystemView; cloud: boolean; notes: { sent: number; failing: number } }) {
  const router = useRouter();
  const [f, setF] = useState<Form>({ ...system, secret: "" });
  const [busy, setBusy] = useState<null | "save" | "test">(null);
  const [notice, setNotice] = useState<{ ok: boolean; msg: string } | null>(null);
  const [ref, setRef] = useState("");
  const [as, setAs] = useState("");
  const [found, setFound] = useState<Found | null>(null);
  const [stateDraft, setStateDraft] = useState("");
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((p) => ({ ...p, [k]: v }));
  const keepsSecret = system.hasSecret && f.kind === system.kind && f.baseUrl.trim().replace(/\/+$/, "") === system.baseUrl.replace(/\/+$/, "");

  function pickKind(k: TicketKind) {
    setF((p) => ({
      ...p, kind: k,
      // The states listed are the kind's own: a ServiceNow list means nothing to Jira.
      allowedStates: k === system.kind ? system.allowedStates : DEFAULT_STATES[k],
      defaultMode: k === "none" && p.defaultMode === "itsm" ? "required" : p.defaultMode,
    }));
    setFound(null);
  }

  function addState() {
    const v = stateDraft.trim();
    if (v && !f.allowedStates.some((s) => s.toLowerCase() === v.toLowerCase())) set("allowedStates", [...f.allowedStates, v]);
    setStateDraft("");
  }

  const body = () => ({ ...f });

  async function onSave(e: React.FormEvent) {
    e.preventDefault();
    setBusy("save");
    setNotice(null);
    try {
      const res = await fetch("/api/admin/ticketing", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body()) });
      const j = (await res.json().catch(() => ({}))) as { message?: string };
      if (res.ok) {
        setNotice({ ok: true, msg: "Saved." });
        set("secret", "");
        router.refresh();
      } else setNotice({ ok: false, msg: j.message ?? "Couldn't save. Check the fields." });
    } finally {
      setBusy(null);
    }
  }

  async function onTest() {
    setBusy("test");
    setFound(null);
    try {
      const res = await fetch("/api/admin/ticketing/test", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body(), ref, as: as.trim() || undefined }) });
      setFound((await res.json().catch(() => ({ ok: false, message: "No answer." }))) as Found);
    } finally {
      setBusy(null);
    }
  }

  const checks = f.kind !== "none";
  const health = system.saved && system.kind !== "none"
    ? system.lastError && (!system.lastOkAt || (system.lastErrorAt ?? "") > system.lastOkAt)
      ? { ok: false, text: system.lastError, at: system.lastErrorAt }
      : system.lastOkAt ? { ok: true, text: "Answering", at: system.lastOkAt } : null
    : null;

  return (
    <div className="em-grid">
      <form className="em-card" onSubmit={(e) => void onSave(e)}>
        <div className="em-card-head">
          <span className="em-card-t">
            <span className="em-card-title">Ticket system</span>
            <span className="cell-sub">Where ticket numbers are looked up, and what a ticket must be to give access.</span>
          </span>
          {health && (
            <span className={health.ok ? "em-chip on" : "em-chip bad"} title={health.text}>
              {health.ok ? "Answering" : "Not answering"}{health.at && <> · <LocalTime iso={health.at} mode="short" /></>}
            </span>
          )}
        </div>
        <div className="em-body">
          {health && !health.ok && <p className="em-notice bad">{health.text}</p>}
          <div className="em-field">
            <span className="em-label">System</span>
            <div className="so-provs lf-kinds" role="group" aria-label="Ticket system">
              {(["servicenow", "jira", "https", "none"] as const).map((k) => (
                <button key={k} type="button" className={f.kind === k ? "so-prov on" : "so-prov"} aria-pressed={f.kind === k} onClick={() => pickKind(k)}>
                  <span className={`lf-kind sm tk-${k}`} aria-hidden="true">{KIND_TILE[k]}</span>
                  <span className="lf-kind-t">{KIND_LABEL[k]}<span className="cell-sub">{KIND_SUB[k]}</span></span>
                </button>
              ))}
            </div>
            {f.kind === "none" && <span className="cell-sub">People type a ticket number and it is kept on the grant, in the audit log and on recordings. Nothing checks it, so approvers do.</span>}
          </div>

          {checks && (
            <>
              <label className="em-field">
                <span className="em-label">{f.kind === "servicenow" ? "Instance" : f.kind === "jira" ? "Site" : "Endpoint URL"}</span>
                <input className="input mono" value={f.baseUrl} onChange={(e) => set("baseUrl", e.target.value)} autoComplete="off" spellCheck={false} required
                  placeholder={f.kind === "servicenow" ? "https://acme.service-now.com" : f.kind === "jira" ? "https://acme.atlassian.net" : "https://itsm.example.com/captivo"} />
                {f.kind === "https" && <span className="cell-sub">Captivo posts <code>{"{event, ticket, user, resource}"}</code> and reads back <code>{"{valid, approved, state, startsAt, endsAt}"}</code>. See How it works.</span>}
              </label>
              <div className="em-two">
                {f.kind !== "https" && (
                  <label className="em-field">
                    <span className="em-label">{f.kind === "servicenow" ? "User" : "Account e-mail"}</span>
                    <input className="input mono" value={f.username} onChange={(e) => set("username", e.target.value)} autoComplete="off" spellCheck={false} required
                      placeholder={f.kind === "servicenow" ? "captivo.integration" : "itsm-bot@acme.com"} />
                  </label>
                )}
                <label className="em-field">
                  <span className="em-label">{f.kind === "servicenow" ? "Password" : f.kind === "jira" ? "API token" : "Bearer token"}
                    <span className="em-label-note">{f.kind === "https" ? "optional, " : ""}stored encrypted</span>
                  </span>
                  <input className="input mono" type="password" value={f.secret} onChange={(e) => set("secret", e.target.value)} autoComplete="new-password"
                    placeholder={keepsSecret ? "•••••••• (blank keeps it)" : ""} />
                </label>
              </div>
              {f.kind === "servicenow" && (
                <div className="em-field">
                  <span className="em-label">Look numbers up in</span>
                  <div className="tk-checks">
                    {SERVICENOW_TABLES.map((t) => (
                      <label key={t.table} className="tk-check">
                        <input type="checkbox" checked={f.tables.includes(t.table)} onChange={(e) => set("tables", e.target.checked ? [...f.tables, t.table] : f.tables.filter((x) => x !== t.table))} />
                        <span>{t.label}<span className="mono t-muted"> {t.prefix}…</span></span>
                      </label>
                    ))}
                  </div>
                  <span className="cell-sub">The account needs read access to these tables, and write access to work notes if notes are on (the itil role covers both).</span>
                </div>
              )}
              {f.kind === "jira" && (
                <div className="em-two">
                  <label className="em-field">
                    <span className="em-label">Window start field<span className="em-label-note">optional</span></span>
                    <input className="input mono" value={f.startField} onChange={(e) => set("startField", e.target.value)} placeholder="customfield_10015" spellCheck={false} />
                  </label>
                  <label className="em-field">
                    <span className="em-label">Window end field<span className="em-label-note">optional</span></span>
                    <input className="input mono" value={f.endField} onChange={(e) => set("endField", e.target.value)} placeholder="customfield_10016" spellCheck={false} />
                  </label>
                </div>
              )}
              {f.kind !== "https" && (
                <div className="em-field">
                  <span className="em-label">States that allow access<span className="em-label-note">as {KIND_LABEL[f.kind]} names them</span></span>
                  <div className="tk-states">
                    {f.allowedStates.map((s) => (
                      <span key={s} className="tk-state">{s}<button type="button" aria-label={`Remove ${s}`} onClick={() => set("allowedStates", f.allowedStates.filter((x) => x !== s))}>×</button></span>
                    ))}
                    <input className="tk-state-input" value={stateDraft} placeholder="Add a state…" onChange={(e) => setStateDraft(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter" || e.key === ",") { e.preventDefault(); addState(); } }} onBlur={addState} aria-label="Add a state" />
                  </div>
                  <span className="cell-sub">A ticket in any other state (closed, cancelled, resolved, in review) gives no access, and ends the access it gave.</span>
                </div>
              )}
              <div className="lf-switches">
                <Switch on={f.matchAssignee} set={(v) => set("matchAssignee", v)} title="Only the person it is assigned to"
                  sub="The ticket's assignee must be the person asking, by e-mail. Stops someone using another person's ticket." />
                <Switch on={f.writeNotes} set={(v) => set("writeNotes", v)} title="Add work notes to the ticket"
                  sub="When a session opens and closes: who, which resource, how long, and a link to its recordings." />
              </div>
              {cloud && <p className="cell-sub lf-hint">Asked from Captivo&apos;s cloud, so the address must be reachable from the internet.</p>}
            </>
          )}

          <div className="em-field">
            <span className="em-label">Resources ask for, by default</span>
            <div className="seg em-enc tk-modes" role="group" aria-label="Default">
              {(["off", "required", "itsm"] as const).map((m) => (
                <button key={m} type="button" disabled={m === "itsm" && !checks} className={f.defaultMode === m ? "seg-opt on" : "seg-opt"} aria-pressed={f.defaultMode === m} onClick={() => set("defaultMode", m)}>
                  {MODE_LABEL[m]}
                </button>
              ))}
            </div>
            <span className="cell-sub">{MODE_SUB[f.defaultMode]} Each resource can differ, below.</span>
          </div>
          {notice && <p className={notice.ok ? "em-notice ok" : "em-notice bad"} role="status">{notice.msg}</p>}
        </div>

        {checks && (
          <div className="em-test">
            <span className="em-label">Look a ticket up</span>
            <div className="em-test-row tk-test-row">
              <input className="input mono" value={ref} onChange={(e) => setRef(e.target.value)} placeholder={f.kind === "jira" ? "OPS-123" : "CHG0030001"} aria-label="Ticket number" spellCheck={false} />
              <input className="input" value={as} onChange={(e) => setAs(e.target.value)} placeholder="For (e-mail, optional)" aria-label="For whom" spellCheck={false} />
              <button type="button" className="btn" disabled={busy !== null || !ref.trim()} onClick={() => void onTest()}>
                {busy === "test" && <span className="em-spin" aria-hidden="true" />}Look up
              </button>
            </div>
            <span className="cell-sub">With these settings, saved or not.</span>
            {found && <FoundCard r={found} />}
          </div>
        )}

        <div className="em-foot">
          <button type="submit" className="btn primary" disabled={busy !== null}>{busy === "save" ? "Saving…" : "Save"}</button>
          {checks && f.writeNotes && system.saved && (
            <span className="cell-sub tk-notes">
              {notes.sent} note{notes.sent === 1 ? "" : "s"} added this week{notes.failing ? <span className="t-bad"> · {notes.failing} not sent yet</span> : null}
            </span>
          )}
        </div>
      </form>

      <aside className="em-aside" aria-label="How it works">
        <span className="em-aside-k">How it works</span>
        <ol className="tk-how">
          <li><b>Someone asks for access</b> and names a ticket. A resource that needs one won&apos;t take a request without it, and neither will an admin&apos;s grant.</li>
          <li><b>The ticket is looked up.</b> It must exist, be in a state that allows access{f.matchAssignee ? ", be assigned to them" : ""} and its change window must not be over. Access is fitted into the window.</li>
          <li><b>Approval.</b> {f.defaultMode === "itsm" ? "Where an approved ticket is enough, a ticket approved in the ticket system opens access at once; a request waiting on one opens when it is approved there." : "An approver decides, seeing the ticket and its state."}</li>
          <li><b>While it lasts</b>, the ticket is asked again every 5 minutes. When it closes, is cancelled or its window ends, the access ends and open sessions are cut within a minute.</li>
          <li><b>On the record.</b> The ticket number is on the grant, in the audit log and on recordings; search Recordings for it.{f.writeNotes && checks ? " Work notes on the ticket say who connected, when, and for how long." : ""}</li>
        </ol>
        {f.kind === "https" && (
          <pre className="lf-preview-body tk-contract">{`POST ${(() => { try { return new URL(f.baseUrl).pathname || "/"; } catch { return "/your/path"; } })()}
Authorization: Bearer …

{ "event": "ticket.check", "ticket": "CHG0030001",
  "user": { "email": "ana@vendor.com", "name": "Ana" },
  "resource": { "id": "…", "name": "CRM" },
  "workspace": "acme" }

200 { "valid": true, "approved": true,
      "state": "Implement", "title": "Patch CRM",
      "startsAt": "2026-11-22T20:00:00Z",
      "endsAt": "2026-11-22T23:00:00Z",
      "url": "https://…" }
404 or { "found": false }: no such ticket

Notes: { "event": "ticket.note", "ticket", "kind", "text" }`}</pre>
        )}
        <span className="cell-sub">If the ticket system doesn&apos;t answer, nothing is opened by a ticket and nothing is ended: requests wait for an approver, and admins can still grant with the ticket marked as not checked.</span>
      </aside>
    </div>
  );
}

function FoundCard({ r }: { r: Found }) {
  if (!r.ok) return <span className="em-result bad" role="status"><b aria-hidden="true">×</b>{r.message}</span>;
  if (!r.found || !r.ticket) return <span className="em-result bad" role="status"><b aria-hidden="true">×</b>No ticket with that number{r.latencyMs !== undefined ? ` (answered in ${r.latencyMs} ms)` : ""}.</span>;
  const t = r.ticket;
  const v = r.verdict;
  return (
    <div className="tk-found" role="status">
      <div className="tk-found-head">
        <span className="mono"><b>{t.ref}</b></span>
        {t.state && <span className="em-chip">{t.state}</span>}
        {t.rejected ? <span className="em-chip bad">Approval rejected</span> : t.approved === true ? <span className="em-chip on">Approved</span> : t.approved === false ? <span className="em-chip warn">Approval pending</span> : null}
        {t.url && <a className="tk-found-link" href={t.url} target="_blank" rel="noreferrer">Open ↗</a>}
      </div>
      {t.title && <div className="tk-found-title">{t.title}</div>}
      <dl className="tk-found-dl">
        <div><dt>Window</dt><dd>{t.start || t.end ? <>{t.start ? <LocalTime iso={t.start} mode="short" /> : "—"} → {t.end ? <LocalTime iso={t.end} mode="short" /> : "—"}</> : "None"}</dd></div>
        <div><dt>Assigned to</dt><dd className="mono">{t.assignee ?? "—"}</dd></div>
        <div><dt>Answered in</dt><dd className="mono">{r.latencyMs} ms</dd></div>
      </dl>
      {v && (
        <span className={v.ok ? "em-result ok" : "em-result bad"}>
          <b aria-hidden="true">{v.ok ? "✓" : "×"}</b>
          {v.ok
            ? `${r.as ?? "This person"} could get access with it${v.approved ? "; where an approved ticket is enough, at once" : "; an approver decides"}.`
            : `${r.as ?? "This person"} couldn't use it: ${v.message}`}
        </span>
      )}
    </div>
  );
}

function Resources({ rows, system }: { rows: ResourceRow[]; system: SystemView }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [q, setQ] = useState("");
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(t);
  }, [toast]);
  const checks = system.saved && system.kind !== "none" && !!system.baseUrl;
  const def = system.saved ? system.defaultMode : "off";
  const effective = (m: TicketMode | null): TicketMode => {
    const v = m ?? def;
    return v === "itsm" && !checks ? "required" : v;
  };
  const shown = rows.filter((r) => !q.trim() || r.name.toLowerCase().includes(q.trim().toLowerCase()) || (r.hostname ?? "").toLowerCase().includes(q.trim().toLowerCase()));

  async function setMode(r: ResourceRow, v: string) {
    setBusy(r.id);
    try {
      const mode = v === "" ? null : v;
      const res = await fetch("/api/admin/ticketing/resources", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ siteIds: [r.id], mode }) });
      if (res.ok) {
        const now = effective(mode as TicketMode | null);
        setToast(`${r.name}: ${MODE_LABEL[now]}.${now !== "off" && r.withoutTicket ? ` ${r.withoutTicket} existing grant${r.withoutTicket === 1 ? "" : "s"} without a ticket keep working until they end.` : ""}`);
        router.refresh();
      } else setToast("Couldn't change it.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="em-card tk-res">
      <div className="em-card-head">
        <span className="em-card-t">
          <span className="em-card-title">Resources</span>
          <span className="cell-sub">What each resource asks for. A rule applies to new requests and grants; existing ones keep working until they end, and access reviews can clear them.</span>
        </span>
        <input className="input tk-res-q" type="search" placeholder="Search resources…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search resources" />
      </div>
      <div className="tk-res-wrap">
        <table className="table tk-res-tbl">
          <thead><tr><th>Resource</th><th>Type</th><th>Asks for</th><th className="num">Live grants with a ticket</th><th className="num">Without</th></tr></thead>
          <tbody>
            {shown.length === 0 && <tr><td colSpan={5} className="t-muted">{rows.length ? "No resource matches." : "No resources yet."}</td></tr>}
            {shown.map((r) => {
              const e = effective(r.mode);
              return (
                <tr key={r.id}>
                  <td><b>{r.name}</b>{r.hostname && <div className="mono cell-sub">{r.hostname}</div>}</td>
                  <td className="t-muted">{TYPE[r.accessMode] ?? r.accessMode}</td>
                  <td>
                    <select className="select sm" value={r.mode ?? ""} disabled={busy === r.id} onChange={(ev) => void setMode(r, ev.target.value)} aria-label={`Ticket rule for ${r.name}`}>
                      <option value="">Default ({MODE_LABEL[effective(null)]})</option>
                      <option value="off">{MODE_LABEL.off}</option>
                      <option value="required">{MODE_LABEL.required}</option>
                      <option value="itsm" disabled={!checks}>{MODE_LABEL.itsm}{checks ? "" : " (needs a ticket system)"}</option>
                    </select>
                    {e !== "off" && <span className={e === "itsm" ? "chip violet tk-mode-chip" : "chip tk-mode-chip"}>{e === "itsm" ? "TICKET = APPROVAL" : "TICKET"}</span>}
                  </td>
                  <td className="num mono">{r.withTicket || "—"}</td>
                  <td className={e !== "off" && r.withoutTicket ? "num mono t-warn" : "num mono"}>{r.withoutTicket || "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {toast && <div className="toast" role="status"><span aria-hidden="true">✓</span> {toast}</div>}
    </section>
  );
}

function Switch({ on, set, title, sub }: { on: boolean; set: (v: boolean) => void; title: string; sub: string }) {
  return (
    <div className="lf-switch">
      <span className="lf-switch-t"><b>{title}</b><span className="cell-sub">{sub}</span></span>
      <button type="button" role="switch" aria-checked={on} aria-label={title} className={on ? "toggle on" : "toggle"} onClick={() => set(!on)}><span /></button>
    </div>
  );
}
