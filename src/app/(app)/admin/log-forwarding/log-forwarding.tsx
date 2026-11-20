"use client";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { LocalTime } from "../../_shell/local-time";
import { useConfirm } from "../../_shell/confirm-dialog";
import { compareSemver } from "@/lib/updates/semver";
import { DATADOG_SITES, DEFAULT_PORT, MAX_DESTINATIONS, type DestinationKind, type Transport } from "@/lib/logforward/config";
import { FACILITIES, datadogBody, genericBody, splunkHecBody, syslogLine, type FormatContext } from "@/lib/logforward/format";
import { sampleRecords } from "@/lib/logforward/records";

export type DestinationView = {
  id: string; name: string; enabled: boolean; kind: DestinationKind;
  transport: Transport | null; host: string | null; port: number | null; framing: "newline" | "octet" | null;
  format: "cef" | "json"; facility: number; caPem: string;
  connectorId: string | null; fallbackConnectorId: string | null;
  url: string | null; datadogSite: string; headerName: string | null; hasSecret: boolean;
  sendSessions: boolean; sendFiles: boolean; sendDenied: boolean; sendAdmin: boolean; sendRequests: boolean;
  sentTotal: number; behind: number;
  lastSentAt: string | null; lastError: string | null; lastErrorAt: string | null; nextAttemptAt: string | null;
};
export type ConnectorOption = { id: string; name: string; online: boolean; version: string | null };

const KIND_LABEL: Record<DestinationKind, string> = { syslog: "Syslog", splunk_hec: "Splunk HEC", datadog: "Datadog", https: "HTTPS" };
const KIND_SUB: Record<DestinationKind, string> = { syslog: "via a connector", splunk_hec: "HTTP Event Collector", datadog: "Logs intake", https: "any endpoint" };
const KIND_TILE: Record<DestinationKind, string> = { syslog: "SYS", splunk_hec: "SPL", datadog: "DD", https: "API" };
const SAVE_ERRORS: Record<string, string> = {
  name_required: "Give the destination a name.",
  invalid_host: "Enter the SIEM's host name or IP address, without a scheme or port.",
  invalid_port: "The port must be between 1 and 65535.",
  connector_required: "Choose the connector that sends the logs.",
  unknown_connector: "That connector no longer exists.",
  invalid_ca: "The CA certificate must be in PEM format (-----BEGIN CERTIFICATE-----).",
  invalid_url: "Enter a full URL, like https://logs.example.com/ingest.",
  https_required: "The address must start with https://.",
  invalid_header: "A header name has only letters, digits and dashes.",
  secret_required: "Enter the token or key once; it is kept after that.",
  invalid_site: "Choose the Datadog site.",
  too_many: `A workspace can have up to ${MAX_DESTINATIONS} destinations.`,
};

type Form = {
  id: string | null; name: string; kind: DestinationKind; enabled: boolean;
  transport: Transport; host: string; port: string; framing: "newline" | "octet"; format: "cef" | "json"; facility: number; caPem: string;
  connectorId: string; fallbackConnectorId: string;
  url: string; datadogSite: string; headerName: string; secret: string; hasSecret: boolean;
  sendSessions: boolean; sendFiles: boolean; sendDenied: boolean; sendAdmin: boolean; sendRequests: boolean;
  backfill: boolean;
};

function newForm(connectors: ConnectorOption[], ok: (c: ConnectorOption) => boolean): Form {
  const first = connectors.find((c) => ok(c) && c.online) ?? connectors.find(ok);
  return {
    id: null, name: "", kind: "syslog", enabled: true,
    transport: "tls", host: "", port: "6514", framing: "newline", format: "cef", facility: 16, caPem: "",
    connectorId: first?.id ?? "", fallbackConnectorId: "",
    url: "", datadogSite: DATADOG_SITES[0].site, headerName: "", secret: "", hasSecret: false,
    sendSessions: true, sendFiles: true, sendDenied: true, sendAdmin: true, sendRequests: false,
    backfill: false,
  };
}

function formOf(d: DestinationView): Form {
  return {
    id: d.id, name: d.name, kind: d.kind, enabled: d.enabled,
    transport: d.transport ?? "tls", host: d.host ?? "", port: String(d.port ?? DEFAULT_PORT[d.transport ?? "tls"]), framing: d.framing ?? "newline",
    format: d.format, facility: d.facility, caPem: d.caPem, connectorId: d.connectorId ?? "", fallbackConnectorId: d.fallbackConnectorId ?? "",
    url: d.kind === "datadog" ? "" : d.url ?? "", datadogSite: d.datadogSite, headerName: d.headerName ?? "", secret: "", hasSecret: d.hasSecret,
    sendSessions: d.sendSessions, sendFiles: d.sendFiles, sendDenied: d.sendDenied, sendAdmin: d.sendAdmin, sendRequests: d.sendRequests,
    backfill: false,
  };
}

const num = (n: number) => n.toLocaleString("en-US");

export function LogForwarding({ destinations, connectors, syslogSince, cloud, ctx }: {
  destinations: DestinationView[]; connectors: ConnectorOption[]; syslogSince: string; cloud: boolean; ctx: FormatContext;
}) {
  const router = useRouter();
  const { confirm, dialog } = useConfirm();
  const canSyslog = (c: ConnectorOption) => (compareSemver(c.version, syslogSince) ?? -1) >= 0;
  const [form, setForm] = useState<Form | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function act(id: string, body: Record<string, unknown>) {
    setBusy(id);
    try {
      await fetch(`/api/admin/log-destinations/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  async function remove(d: DestinationView) {
    if (!(await confirm(`Remove ${d.name}? Records stop going there; nothing already delivered is touched.`, { danger: true, confirmLabel: "Remove" }))) return;
    setBusy(d.id);
    try {
      await fetch(`/api/admin/log-destinations/${d.id}`, { method: "DELETE" });
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  if (form) {
    return (
      <Editor
        key={form.id ?? "new"} initial={form} connectors={connectors} canSyslog={canSyslog} syslogSince={syslogSince} cloud={cloud} ctx={ctx}
        onDone={(saved) => { setForm(null); if (saved) router.refresh(); }}
      />
    );
  }

  return (
    <>
      {dialog}
      {destinations.length === 0 ? (
        <div className="lf-empty">
          <div className="so-methods lf-ways">
            <div className="so-method">
              <span className="so-method-ic p" aria-hidden="true"><Ic d={["M9 7V4M15 7V4", "M7 7h10v4a5 5 0 0 1-10 0z", "M12 16v4"]} /></span>
              <span className="so-method-t">
                <span className="so-method-who">On your network</span>
                <b>Syslog through a connector</b>
                <span className="cell-sub">UDP, TCP or TLS to QRadar, ArcSight, Sentinel (AMA), Wazuh, Graylog or any syslog server. The SIEM needs no opening to the internet.</span>
              </span>
            </div>
            <div className="so-method">
              <span className="so-method-ic a" aria-hidden="true"><Ic d={["M7 18a4 4 0 0 1-.5-7.97A6 6 0 0 1 18 9a4 4 0 0 1 0 9z"]} /></span>
              <span className="so-method-t">
                <span className="so-method-who">In the cloud</span>
                <b>Splunk, Datadog or any HTTPS endpoint</b>
                <span className="cell-sub">Sent from Captivo directly, as JSON. For a SIEM that takes logs over the internet.</span>
              </span>
            </div>
          </div>
          <p className="cell-sub">Each record goes out once it is written, normally within seconds. If the SIEM can&apos;t be reached, the records wait and are sent when it is back: nothing is skipped.</p>
          <div><button type="button" className="btn primary" onClick={() => setForm(newForm(connectors, canSyslog))}>Add destination</button></div>
        </div>
      ) : (
        <div className="lf-list">
          {destinations.map((d) => (
            <DestinationCard
              key={d.id} d={d} connectors={connectors} busy={busy === d.id}
              onEdit={() => setForm(formOf(d))}
              onToggle={() => void act(d.id, { enabled: !d.enabled })}
              onRetry={() => void act(d.id, { action: "retry" })}
              onRemove={() => void remove(d)}
            />
          ))}
          <div className="lf-add">
            <button type="button" className="btn" disabled={destinations.length >= MAX_DESTINATIONS} onClick={() => setForm(newForm(connectors, canSyslog))}>Add destination</button>
            <span className="cell-sub">{destinations.length >= MAX_DESTINATIONS ? `Up to ${MAX_DESTINATIONS} destinations.` : "Send the same records to another SIEM or archive too."}</span>
          </div>
        </div>
      )}
    </>
  );
}

function where(d: Pick<DestinationView, "kind" | "transport" | "host" | "port" | "url" | "datadogSite">): string {
  if (d.kind === "syslog") return `${(d.transport ?? "").toUpperCase()} ${d.host}:${d.port}`;
  if (d.kind === "datadog") return `Datadog ${DATADOG_SITES.find((s) => s.site === d.datadogSite)?.label ?? ""}`;
  try {
    return new URL(d.url ?? "").host;
  } catch {
    return d.url ?? "";
  }
}

function DestinationCard({ d, connectors, busy, onEdit, onToggle, onRetry, onRemove }: {
  d: DestinationView; connectors: ConnectorOption[]; busy: boolean;
  onEdit: () => void; onToggle: () => void; onRetry: () => void; onRemove: () => void;
}) {
  const via = connectors.find((c) => c.id === d.connectorId);
  const state = !d.enabled ? "paused" : d.lastError ? "failing" : d.lastSentAt ? "ok" : "waiting";
  const STATE = { paused: ["Paused", ""], failing: ["Failing", "bad"], ok: ["Delivering", "on"], waiting: ["Waiting for records", ""] } as const;
  const sends = [d.sendSessions && "sessions", d.sendFiles && "file transfers", d.sendDenied && "denials", d.sendAdmin && "admin activity", d.sendRequests && "every web request"].filter(Boolean).join(", ");
  return (
    <section className="em-card lf-card" aria-label={d.name}>
      <div className="em-card-head">
        <span className={`lf-kind ${d.kind}`} aria-hidden="true">{KIND_TILE[d.kind]}</span>
        <span className="em-card-t">
          <span className="em-card-title">{d.name}<span className={`em-chip ${STATE[state][1]}`}>{STATE[state][0]}</span></span>
          <span className="cell-sub mono lf-where">
            {KIND_LABEL[d.kind]} · {where(d)}
            {d.kind === "syslog" && <> · via {via ? via.name : <span className="t-bad">a removed connector</span>}{d.format === "json" ? " · JSON" : " · CEF"}</>}
          </span>
        </span>
        <button type="button" role="switch" aria-checked={d.enabled} aria-label={`Send to ${d.name}`} disabled={busy}
          className={d.enabled ? "toggle on" : "toggle"} onClick={onToggle}><span /></button>
      </div>
      {d.enabled && d.lastError && (
        <div className="lf-fail" role="alert">
          <span className="lf-fail-t">
            <b>{d.lastError}</b>
            <span className="cell-sub">
              {d.lastErrorAt && <>Since <LocalTime iso={d.lastErrorAt} mode="short" />. </>}
              {num(d.behind)} record{d.behind === 1 ? "" : "s"} waiting; they are sent once it works again.
              {d.nextAttemptAt && <> Next try <LocalTime iso={d.nextAttemptAt} mode="time" />.</>}
            </span>
          </span>
          <button type="button" className="btn sm" disabled={busy} onClick={onRetry}>Retry now</button>
        </div>
      )}
      <dl className="lf-stats">
        <div><dt>Last delivered</dt><dd>{d.lastSentAt ? <LocalTime iso={d.lastSentAt} mode="short" /> : "Not yet"}</dd></div>
        <div><dt>Records sent</dt><dd className="mono">{num(d.sentTotal)}</dd></div>
        <div><dt>Waiting</dt><dd className="mono">{d.enabled ? num(d.behind) : "—"}</dd></div>
        <div className="lf-sends"><dt>Sends</dt><dd>{sends || "Nothing selected"}</dd></div>
      </dl>
      <div className="em-foot">
        <button type="button" className="btn sm" onClick={onEdit}>Edit</button>
        <span className="so-foot-gap" />
        <button type="button" className="btn sm so-remove" disabled={busy} onClick={onRemove}>Remove</button>
      </div>
    </section>
  );
}

function Editor({ initial, connectors, canSyslog, syslogSince, cloud, ctx, onDone }: {
  initial: Form; connectors: ConnectorOption[]; canSyslog: (c: ConnectorOption) => boolean; syslogSince: string; cloud: boolean; ctx: FormatContext;
  onDone: (saved: boolean) => void;
}) {
  const [f, setF] = useState<Form>(initial);
  const [busy, setBusy] = useState<null | "save" | "test">(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((p) => ({ ...p, [k]: v }));
  const isNew = f.id === null;

  function pickTransport(t: Transport) {
    setF((p) => ({ ...p, transport: t, port: p.port === String(DEFAULT_PORT[p.transport]) || !p.port ? String(DEFAULT_PORT[t]) : p.port }));
  }

  function body() {
    return {
      id: f.id ?? undefined, name: f.name, kind: f.kind, enabled: f.enabled,
      transport: f.transport, host: f.host, port: f.port, framing: f.framing, format: f.format, facility: f.facility, caPem: f.caPem,
      connectorId: f.connectorId, fallbackConnectorId: f.fallbackConnectorId,
      url: f.url, datadogSite: f.datadogSite, headerName: f.headerName, secret: f.secret,
      sendSessions: f.sendSessions, sendFiles: f.sendFiles, sendDenied: f.sendDenied, sendAdmin: f.sendAdmin, sendRequests: f.sendRequests,
      ...(isNew && f.backfill ? { backfill: "24h" } : {}),
    };
  }

  async function onSave(e: React.FormEvent) {
    e.preventDefault();
    setBusy("save");
    setNotice(null);
    try {
      const res = await fetch(isNew ? "/api/admin/log-destinations" : `/api/admin/log-destinations/${f.id}`, {
        method: isNew ? "POST" : "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body()),
      });
      if (res.ok) return onDone(true);
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      setNotice(SAVE_ERRORS[j.error ?? ""] ?? "Couldn't save. Check the fields.");
    } finally {
      setBusy(null);
    }
  }

  async function onTest() {
    setBusy("test");
    setResult(null);
    setNotice(null);
    try {
      const res = await fetch("/api/admin/log-destinations/test", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body()) });
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; message?: string; latencyMs?: number };
      if (j.error) setResult({ ok: false, msg: SAVE_ERRORS[j.error] ?? "Check the fields." });
      else setResult(j.ok
        ? { ok: true, msg: `Test record delivered${typeof j.latencyMs === "number" ? ` in ${j.latencyMs} ms` : ""}. Look for "Test from Captivo Access" in the SIEM.` }
        : { ok: false, msg: j.message ?? "It didn't arrive." });
    } finally {
      setBusy(null);
    }
  }

  const via = connectors.find((c) => c.id === f.connectorId);
  const usable = connectors.filter(canSyslog);

  return (
    <div className="em-grid">
      <form className="em-card" onSubmit={(e) => void onSave(e)}>
        <div className="em-card-head">
          <span className="em-card-t">
            <span className="em-card-title">{isNew ? "New destination" : `Edit ${initial.name}`}</span>
            <span className="cell-sub">{f.kind === "syslog" ? "The connector you choose sends the records to the SIEM on its network." : "Captivo sends the records to this service directly."}</span>
          </span>
        </div>
        <div className="em-body">
          <div className="em-field">
            <span className="em-label">Send to</span>
            <div className="so-provs lf-kinds" role="group" aria-label="Kind">
              {(["syslog", "splunk_hec", "datadog", "https"] as const).map((k) => (
                <button key={k} type="button" className={f.kind === k ? "so-prov on" : "so-prov"} aria-pressed={f.kind === k} onClick={() => set("kind", k)}>
                  <span className={`lf-kind sm ${k}`} aria-hidden="true">{KIND_TILE[k]}</span>
                  <span className="lf-kind-t">{KIND_LABEL[k]}<span className="cell-sub">{KIND_SUB[k]}</span></span>
                </button>
              ))}
            </div>
          </div>

          <label className="em-field">
            <span className="em-label">Name</span>
            <input className="input" value={f.name} onChange={(e) => set("name", e.target.value)} placeholder={f.kind === "syslog" ? "QRadar" : KIND_LABEL[f.kind]} maxLength={80} required />
          </label>

          {f.kind === "syslog" && (
            <>
              <div className="em-two">
                <label className="em-field">
                  <span className="em-label">Connector</span>
                  <select className="select" value={f.connectorId} onChange={(e) => set("connectorId", e.target.value)} required>
                    {!f.connectorId && <option value="">Choose…</option>}
                    {connectors.map((c) => (
                      <option key={c.id} value={c.id} disabled={!canSyslog(c)}>
                        {c.name}{!canSyslog(c) ? ` (update to ${syslogSince})` : c.online ? "" : " (offline)"}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="em-field">
                  <span className="em-label">If it&apos;s offline<span className="em-label-note">optional</span></span>
                  <select className="select" value={f.fallbackConnectorId} onChange={(e) => set("fallbackConnectorId", e.target.value)}>
                    <option value="">Wait for it</option>
                    {usable.filter((c) => c.id !== f.connectorId).map((c) => <option key={c.id} value={c.id}>Use {c.name}</option>)}
                  </select>
                </label>
              </div>
              {usable.length === 0 && (
                <p className="em-notice warn">No connector can forward logs yet: syslog needs connector {syslogSince} or newer. Update one from Connectors.</p>
              )}
              <div className="em-hostport">
                <label className="em-field">
                  <span className="em-label">SIEM address</span>
                  <input className="input mono" value={f.host} onChange={(e) => set("host", e.target.value)} placeholder="siem.corp.local or 10.0.0.25" autoComplete="off" spellCheck={false} required />
                </label>
                <label className="em-field">
                  <span className="em-label">Port</span>
                  <input className="input mono" inputMode="numeric" value={f.port} onChange={(e) => set("port", e.target.value.replace(/\D/g, ""))} />
                </label>
              </div>
              <div className="em-field">
                <span className="em-label">Transport</span>
                <div className="seg em-enc" role="group" aria-label="Transport">
                  {(["tls", "tcp", "udp"] as const).map((t) => (
                    <button key={t} type="button" className={f.transport === t ? "seg-opt on" : "seg-opt"} aria-pressed={f.transport === t} onClick={() => pickTransport(t)}>
                      {t.toUpperCase()}<span className="mono t-muted">{DEFAULT_PORT[t]}</span>
                    </button>
                  ))}
                </div>
                <span className="cell-sub">
                  {f.transport === "tls" && "Encrypted and confirmed (RFC 5425). The SIEM's certificate is checked."}
                  {f.transport === "tcp" && "Confirmed delivery, unencrypted on your network."}
                  {f.transport === "udp" && "No delivery confirmation: a record lost on the network is not sent again. Prefer TCP or TLS when the SIEM takes them."}
                </span>
              </div>
              <div className="em-two">
                <div className="em-field">
                  <span className="em-label">Message format</span>
                  <div className="seg em-enc" role="group" aria-label="Message format">
                    <button type="button" className={f.format === "cef" ? "seg-opt on" : "seg-opt"} aria-pressed={f.format === "cef"} onClick={() => set("format", "cef")}>CEF</button>
                    <button type="button" className={f.format === "json" ? "seg-opt on" : "seg-opt"} aria-pressed={f.format === "json"} onClick={() => set("format", "json")}>JSON</button>
                  </div>
                  <span className="cell-sub">{f.format === "cef" ? "QRadar, ArcSight and Sentinel read CEF without a parser." : "For Splunk, Elastic, Wazuh and Graylog."}</span>
                </div>
                <label className="em-field">
                  <span className="em-label">Facility</span>
                  <select className="select" value={f.facility} onChange={(e) => set("facility", Number(e.target.value))}>
                    {FACILITIES.map((x) => <option key={x.code} value={x.code}>{x.label} ({x.code})</option>)}
                  </select>
                </label>
              </div>
              {f.transport !== "udp" && (
                <div className="em-field">
                  <span className="em-label">Framing</span>
                  <div className="seg em-enc" role="group" aria-label="Framing">
                    <button type="button" className={f.framing === "newline" ? "seg-opt on" : "seg-opt"} aria-pressed={f.framing === "newline"} onClick={() => set("framing", "newline")}>One per line</button>
                    <button type="button" className={f.framing === "octet" ? "seg-opt on" : "seg-opt"} aria-pressed={f.framing === "octet"} onClick={() => set("framing", "octet")}>Octet counting</button>
                  </div>
                  <span className="cell-sub">Most SIEMs take one message per line. Choose octet counting (RFC 6587) if yours asks for it.</span>
                </div>
              )}
              {f.transport === "tls" && (
                <label className="em-field">
                  <span className="em-label">CA certificate<span className="em-label-note">optional: when the SIEM&apos;s certificate is from your own CA</span></span>
                  <textarea className="textarea mono lf-pem" rows={3} value={f.caPem} onChange={(e) => set("caPem", e.target.value)} placeholder="-----BEGIN CERTIFICATE-----" spellCheck={false} />
                </label>
              )}
              {via && <p className="cell-sub lf-hint">If {via.name}&apos;s egress is narrowed in Policy, add {f.host || "the SIEM"}:{f.port || DEFAULT_PORT[f.transport]} to its allowed targets.</p>}
            </>
          )}

          {(f.kind === "splunk_hec" || f.kind === "https") && (
            <label className="em-field">
              <span className="em-label">{f.kind === "splunk_hec" ? "HEC address" : "Endpoint URL"}</span>
              <input className="input mono" value={f.url} onChange={(e) => set("url", e.target.value)} autoComplete="off" spellCheck={false} required
                placeholder={f.kind === "splunk_hec" ? "https://http-inputs-acme.splunkcloud.com" : "https://logs.example.com/ingest"} />
              {f.kind === "splunk_hec" && <span className="cell-sub">Without a path, /services/collector/event is used.</span>}
            </label>
          )}
          {f.kind === "datadog" && (
            <label className="em-field">
              <span className="em-label">Datadog site</span>
              <select className="select" value={f.datadogSite} onChange={(e) => set("datadogSite", e.target.value)}>
                {DATADOG_SITES.map((s) => <option key={s.site} value={s.site}>{s.label} · {s.site}</option>)}
              </select>
            </label>
          )}
          {f.kind === "https" && (
            <label className="em-field">
              <span className="em-label">Header<span className="em-label-note">optional</span></span>
              <input className="input mono" value={f.headerName} onChange={(e) => set("headerName", e.target.value)} placeholder="Authorization" autoComplete="off" spellCheck={false} />
            </label>
          )}
          {(f.kind === "splunk_hec" || f.kind === "datadog" || (f.kind === "https" && f.headerName.trim())) && (
            <label className="em-field">
              <span className="em-label">{f.kind === "splunk_hec" ? "HEC token" : f.kind === "datadog" ? "API key" : "Header value"}
                <span className="em-label-note">stored encrypted, never shown again</span>
              </span>
              <input className="input mono" type="password" value={f.secret} onChange={(e) => set("secret", e.target.value)} autoComplete="new-password"
                placeholder={f.hasSecret && f.kind === initial.kind ? "•••••••• (blank keeps it)" : f.kind === "https" ? "Bearer …" : ""} />
            </label>
          )}
          {f.kind !== "syslog" && cloud && <p className="cell-sub lf-hint">Sent from Captivo&apos;s cloud, so the address must be reachable from the internet. For a SIEM on your own network, use syslog through a connector.</p>}

          <div className="em-field">
            <span className="em-label">Send</span>
            <div className="lf-switches">
              <Switch on={f.sendSessions} set={(v) => set("sendSessions", v)} title="Sessions" sub="Opened and closed, with who, what and from where." />
              <Switch on={f.sendFiles} set={(v) => set("sendFiles", v)} title="File transfers" sub="Uploads and downloads in remote desktop and web app sessions." />
              <Switch on={f.sendDenied} set={(v) => set("sendDenied", v)} title="Denied access" sub="Every refusal: no grant, outside its hours, IP not allowed, account disabled." />
              <Switch on={f.sendAdmin} set={(v) => set("sendAdmin", v)} title="Admin activity" sub="Grants, resources, policy and settings changed in the console." />
              <Switch on={f.sendRequests} set={(v) => set("sendRequests", v)} title="Every web request" sub="Each page and API call in web apps. Can be many records a day." />
            </div>
          </div>

          {isNew && (
            <div className="em-field">
              <span className="em-label">Start with</span>
              <div className="seg em-enc" role="group" aria-label="Start with">
                <button type="button" className={!f.backfill ? "seg-opt on" : "seg-opt"} aria-pressed={!f.backfill} onClick={() => set("backfill", false)}>New records</button>
                <button type="button" className={f.backfill ? "seg-opt on" : "seg-opt"} aria-pressed={f.backfill} onClick={() => set("backfill", true)}>Also the last 24 hours</button>
              </div>
            </div>
          )}

          {notice && <p className="em-notice bad" role="alert">{notice}</p>}
        </div>

        <div className="em-test lf-test">
          <span className="em-label">Send a test record</span>
          <div className="em-test-row">
            <span className="cell-sub lf-test-sub">One record, with these settings, saved or not.</span>
            <button type="button" className="btn" disabled={busy !== null} onClick={() => void onTest()}>
              {busy === "test" && <span className="em-spin" aria-hidden="true" />}Send test
            </button>
          </div>
          {result && <span className={result.ok ? "em-result ok" : "em-result bad"} role="status"><b aria-hidden="true">{result.ok ? "✓" : "×"}</b>{result.msg}</span>}
        </div>

        <div className="em-foot">
          <button type="submit" className="btn primary" disabled={busy !== null}>{busy === "save" ? "Saving…" : isNew ? "Add destination" : "Save"}</button>
          <button type="button" className="btn" disabled={busy !== null} onClick={() => onDone(false)}>Cancel</button>
        </div>
      </form>

      <Preview f={f} ctx={ctx} />
    </div>
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

function Preview({ f, ctx }: { f: Form; ctx: FormatContext }) {
  const text = useMemo(() => {
    const recs = sampleRecords();
    if (f.kind === "syslog") {
      const lines = recs.map((r) => syslogLine(r, ctx, { format: f.format, facility: f.facility }));
      if (f.transport !== "udp" && f.framing === "octet") return lines.map((l) => `${new TextEncoder().encode(l).length} ${l}`).join("\n\n");
      return lines.join("\n\n");
    }
    if (f.kind === "splunk_hec") return splunkHecBody(recs.slice(0, 2), ctx).split("\n").map((l) => JSON.stringify(JSON.parse(l), null, 2)).join("\n");
    if (f.kind === "datadog") return JSON.stringify(JSON.parse(datadogBody(recs.slice(0, 1), ctx)), null, 2);
    return JSON.stringify(JSON.parse(genericBody(recs.slice(0, 1), ctx)), null, 2);
  }, [f.kind, f.format, f.facility, f.transport, f.framing, ctx]);
  const head = f.kind === "syslog"
    ? `${f.transport.toUpperCase()} → ${f.host || "siem"}:${f.port || DEFAULT_PORT[f.transport]}`
    : f.kind === "splunk_hec" ? "POST /services/collector/event · Authorization: Splunk …"
      : f.kind === "datadog" ? `POST http-intake.logs.${f.datadogSite}/api/v2/logs · DD-API-KEY: …`
        : `POST ${(() => { try { return new URL(f.url).host || "your endpoint"; } catch { return "your endpoint"; } })()} · application/json`;
  return (
    <aside className="em-aside" aria-label="What the SIEM receives">
      <span className="em-aside-k">What the SIEM receives</span>
      <div className="lf-preview">
        <div className="lf-preview-head mono">{head}</div>
        <pre className="lf-preview-body">{text}</pre>
      </div>
      <span className="cell-sub">Three sample records: a session opened, a denied request and an admin&apos;s change. Real records carry your workspace&apos;s names and addresses.</span>
    </aside>
  );
}

function Ic({ d }: { d: string[] }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {d.map((p) => <path key={p} d={p} />)}
    </svg>
  );
}
