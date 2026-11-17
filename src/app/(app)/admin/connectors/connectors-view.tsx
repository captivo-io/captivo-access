"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { textMatch } from "@/lib/table/filter";
import { NavIcon } from "@/app/(app)/_shell/nav-icons";
import { UpdateConnectorButton } from "./update-connector-button";
import { RepairConnectorButton } from "./repair-connector-button";
import { DeleteConnectorButton } from "./delete-connector-button";
import type { DayState, EventLevel } from "@/lib/connector/history";

export interface ConnectorCard {
  id: string;
  name: string;
  status: "PENDING" | "ONLINE" | "OFFLINE" | "REVOKED";
  version: string | null;
  outdated: boolean;
  createdAt: string;
  lastSeenAt: string | null;
  /** Age of the latest telemetry while the tunnel is up, ms. */
  signalAgeMs: number | null;
  remoteAddr: string | null;
  /** The host the connector runs on; null until a connector that reports it (2.25.0+) connects. */
  hostname: string | null;
  os: string | null;
  localIp: string | null;
  /** One tunnel round trip, measured by the data-plane when the page loads. */
  edgeLatencyMs: number | null;
  uptimeSec: number | null;
  activeTunnels: number | null;
  totalConnections: number | null;
  deniedCount: number | null;
  bytesIn: number | null;
  bytesOut: number | null;
  spark: number[];
  resources: number;
  unreachable: number;
  uptime: { pct: number | null; downtimeMin: number; days: { date: string; state: DayState; minutes: number }[] };
  events: { at: string; level: EventLevel; text: string }[];
}

type Filter = "all" | "online" | "offline" | "outdated";

/**
 * Connectors, as the design hand-off (README 7.7) lays them out: a KPI strip,
 * search and a status filter, and a card per connector with its update band,
 * metrics, the 30-day uptime strip, details and a menu. Every figure is real:
 * history the console does not keep yet is left out rather than invented.
 */
export function ConnectorsView({
  connectors,
  mgr,
  updateCommand,
  managerUrlIsLocal,
}: {
  connectors: ConnectorCard[];
  mgr: string;
  updateCommand: string;
  managerUrlIsLocal: boolean;
}) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [toast, setToast] = useState<string | null>(null);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2600);
    return () => clearTimeout(t);
  }, [toast]);

  const online = connectors.filter((c) => c.status === "ONLINE").length;
  const outdated = connectors.filter((c) => c.status !== "REVOKED" && c.outdated).length;
  const resources = connectors.reduce((n, c) => n + c.resources, 0);
  const unreachable = connectors.reduce((n, c) => n + c.unreachable, 0);
  const shown = connectors.filter((c) => {
    if (filter === "online" && c.status !== "ONLINE") return false;
    if (filter === "offline" && c.status === "ONLINE") return false;
    if (filter === "outdated" && !(c.outdated && c.status !== "REVOKED")) return false;
    return textMatch([c.name, c.id, c.version, c.remoteAddr, c.hostname, c.localIp, c.os], q);
  });

  return (
    <div className="cn">
      <div className="kstrip rs-summary" role="list">
        <Cell dot="muted" label="Total" value={connectors.length} sub={`${online} online`} on={filter === "all"} onClick={() => setFilter("all")} />
        <Cell dot="ok" label="Online" value={online} sub={online === connectors.length ? "all connected" : `${connectors.length - online} offline`} on={filter === "online"} onClick={() => setFilter("online")} />
        <Cell dot="warn" label="Out of date" value={outdated} sub={outdated ? "update ready" : "all current"} on={filter === "outdated"} onClick={() => setFilter("outdated")} />
        <Link href="/admin/sites" className="kcell rs-cell cn-cell-link" role="listitem">
          <span className="kcell-k"><span className="rs-kdot p" aria-hidden="true" />Resources served</span>
          <span className="kcell-row">
            <span className="kcell-v">{resources}</span>
            <span className={unreachable ? "kcell-s t-bad" : "kcell-s"}>{unreachable ? `${unreachable} unreachable` : "all reachable"}</span>
          </span>
        </Link>
      </div>

      <div className="rs-tools">
        <label className="ma-search rs-search">
          <NavIcon name="search" size={16} />
          <input type="search" placeholder="Search name, host, version, IP or id…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search connectors" />
          {q && <button type="button" className="rs-clear" aria-label="Clear search" onClick={() => setQ("")}>×</button>}
        </label>
        <div className="seg" role="group" aria-label="Status">
          {([["all", "All", connectors.length], ["online", "Online", online], ["offline", "Offline", connectors.length - online], ["outdated", "Out of date", outdated]] as const).map(([k, l, n]) => (
            <button key={k} type="button" className={filter === k ? "seg-opt on" : "seg-opt"} aria-pressed={filter === k} onClick={() => setFilter(k)}>{l} <span className="rs-n">{n}</span></button>
          ))}
        </div>
      </div>

      {shown.length === 0 ? (
        <div className="rs-none">
          <span>No connectors match the filters.</span>
          <button type="button" className="btn sm" onClick={() => { setQ(""); setFilter("all"); }}>Clear filters</button>
        </div>
      ) : (
        <div className="cn-list">
          {shown.map((c) => (
            <Card key={c.id} c={c} mgr={mgr} updateCommand={updateCommand} managerUrlIsLocal={managerUrlIsLocal}
              onRevoked={() => { setToast(`${c.name} revoked`); router.refresh(); }} />
          ))}
        </div>
      )}
      {toast && <div className="toast" role="status"><span aria-hidden="true">✓</span> {toast}</div>}
    </div>
  );
}

function Cell({ dot, label, value, sub, on, onClick }: { dot: string; label: string; value: number; sub: string; on: boolean; onClick: () => void }) {
  return (
    <button type="button" className={on ? `kcell rs-cell on ${dot}` : "kcell rs-cell"} role="listitem" aria-pressed={on} onClick={onClick}>
      <span className="kcell-k"><span className={`rs-kdot ${dot}`} aria-hidden="true" />{label}</span>
      <span className="kcell-row"><span className="kcell-v">{value}</span><span className="kcell-s">{sub}</span></span>
    </button>
  );
}

export function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
export function duration(sec: number): string {
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}
function bytes(n: number): string {
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n < 10 && i ? n.toFixed(1) : Math.round(n)} ${u[i]}`;
}
export function uptimePct(p: number): string {
  return p >= 99.995 ? "100%" : `${p.toFixed(2)}%`;
}
/** "85.105.12.4:51234" → "85.105.•••.•••": the address names the site; the card needs only a hint. */
export function maskIp(addr: string): string {
  const host = addr.replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
  const p = host.split(".");
  return p.length === 4 ? `${p[0]}.${p[1]}.•••.•••` : `${host.split(":").slice(0, 2).join(":")}:•••`;
}
const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const date = (iso: string) => new Date(iso).toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" });

function Card({ c, mgr, updateCommand, managerUrlIsLocal, onRevoked }: { c: ConnectorCard; mgr: string; updateCommand: string; managerUrlIsLocal: boolean; onRevoked: () => void }) {
  const [open, setOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const revoked = c.status === "REVOKED";
  const on = c.status === "ONLINE";
  const signal = c.signalAgeMs != null ? Date.now() - c.signalAgeMs : c.lastSeenAt ? Date.parse(c.lastSeenAt) : null;
  const pill = revoked ? ["bad", "Revoked"] : on ? ["up", "Online"] : c.status === "PENDING" ? ["unknown", "Waiting to connect"] : ["down", "Offline"];

  return (
    <article className={revoked ? "cn-card revoked" : "cn-card"}>
      <div className="cn-head">
        <span className={on ? "cn-tile" : "cn-tile off"}><NavIcon name="plug" size={22} />{on && <i className="cn-live" aria-hidden="true" />}</span>
        <div className="cn-id">
          {renaming ? (
            <Rename id={c.id} name={c.name} done={() => setRenaming(false)} />
          ) : (
            <div className="cn-name">
              <b title={c.name}>{c.name}</b>
              {!revoked && (
                <button type="button" className="rs-copy" aria-label={`Rename ${c.name}`} title="Rename" onClick={() => setRenaming(true)}>
                  <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>
                </button>
              )}
            </div>
          )}
          <div className="cn-meta mono">
            <span title={c.id}>{c.id.slice(0, 10)}</span>
            {c.hostname && <span>{c.hostname}</span>}
            {c.version && <span>v{c.version}</span>}
            <span>paired {date(c.createdAt)}</span>
          </div>
        </div>
        <div className="cn-state">
          <span className={`rs-pill ${pill[0]}`}><span className="rs-pdot" aria-hidden="true" /> {pill[1]}</span>
          {signal != null && !revoked && <span className="cn-signal">Last signal: {ago(Date.now() - signal)} · {time(new Date(signal).toISOString())}</span>}
        </div>
      </div>

      {revoked ? (
        <div className="cn-band bad">
          <span>This connector&apos;s access is revoked; it can no longer connect.</span>
          {c.resources === 0 ? <DeleteConnectorButton id={c.id} name={c.name} /> : <span className="t-muted">Remove its {c.resources} resource{c.resources === 1 ? "" : "s"} under Resources to delete it.</span>}
        </div>
      ) : (
        <>
          {c.outdated && (
            <div className="cn-band warn">
              <span className="cn-chip mono">{c.version ?? "?"} → {mgr}</span>
              <span className="cn-band-t">A new version is ready. Updating keeps the token and pairing; sessions on it end while it restarts.</span>
              <a className="cn-notes" href={`https://github.com/captivo-io/captivo-access/releases/tag/v${mgr}`} target="_blank" rel="noreferrer">Release notes</a>
              <UpdateConnectorButton command={updateCommand} managerUrlIsLocal={managerUrlIsLocal} label="Update now" className="btn sm ink" />
            </div>
          )}

          <div className="cn-metrics">
            <div>
              <i>Edge latency</i>
              <b className="mono">{on && c.edgeLatencyMs != null ? latency(c.edgeLatencyMs) : "—"}</b>
              <span>{!on ? "not connected" : c.edgeLatencyMs != null ? "round trip to Captivo" : "no answer to the ping"}</span>
            </div>
            <div>
              <i>Uptime · 30d</i>
              <b className="mono">{c.uptime.pct == null ? "—" : uptimePct(c.uptime.pct)}</b>
              <span>{c.uptime.pct == null ? "history starts with the next check" : c.uptime.downtimeMin ? `${duration(c.uptime.downtimeMin * 60)} down` : "no downtime"}</span>
            </div>
            <div>
              <i>Active tunnels</i>
              <span className="cn-tun"><b className="mono">{on ? (c.activeTunnels ?? 0) : 0}</b><Spark values={c.spark} /></span>
              <span>{c.totalConnections != null ? `${c.totalConnections.toLocaleString()} since start` : "last 80 minutes"}</span>
            </div>
            <div>
              <i>Resources served</i>
              <b className="mono">{c.resources}</b>
              {c.unreachable ? <Link href="/admin/sites?status=down" className="t-bad">{c.unreachable} unreachable →</Link> : <span>{c.resources ? "all reachable" : "none yet"}</span>}
            </div>
          </div>

          <Strip days={c.uptime.days} />

          {open && (
            <div className="cn-details">
              <div className="cn-dcard">
                <h3>System</h3>
                <dl>
                  <dt>Hostname</dt><dd className="mono">{c.hostname ?? <Later on={on} />}</dd>
                  <dt>Operating system</dt><dd>{c.os ?? <Later on={on} />}</dd>
                  <dt>Local IP</dt><dd className="mono">{c.localIp ?? <Later on={on} />}</dd>
                  <dt>Public IP</dt><dd className="mono" title={c.remoteAddr ?? undefined}>{c.remoteAddr ? maskIp(c.remoteAddr) : "—"}</dd>
                  <dt>Version</dt><dd className="mono">{c.version ?? "—"}</dd>
                  <dt>Connected for</dt><dd className="mono">{on && c.uptimeSec != null ? duration(c.uptimeSec) : "—"}</dd>
                  <dt>Connections</dt><dd className="mono">{c.totalConnections != null ? c.totalConnections.toLocaleString() : "—"}</dd>
                  <dt>Blocked by egress</dt><dd className="mono">{c.deniedCount != null ? c.deniedCount.toLocaleString() : "—"}</dd>
                  <dt>Traffic</dt><dd className="mono">{c.bytesIn != null && c.bytesOut != null ? `↓ ${bytes(c.bytesIn)} · ↑ ${bytes(c.bytesOut)}` : "—"}</dd>
                  <dt>Connector id</dt><dd className="mono">{c.id}</dd>
                </dl>
              </div>
              <div className="cn-dcard">
                <h3>Recent events</h3>
                {c.events.length === 0 ? (
                  <p className="t-muted cn-noev">Nothing recorded yet. Tunnel, version and target changes appear here.</p>
                ) : (
                  <ul className="cn-events">
                    {c.events.map((e, i) => (
                      <li key={i}><span className="mono" title={new Date(e.at).toLocaleString()}>{time(e.at)}</span><i className={`cn-edot ${e.level}`} aria-hidden="true" /><span>{e.text}</span></li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          )}

          <div className="cn-foot">
            <button type="button" className="btn sm ghost cn-more" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
              Details <span className={open ? "cn-chev open" : "cn-chev"} aria-hidden="true">▾</span>
            </button>
            <RepairConnectorButton id={c.id} />
            <Link href={`/admin/sites?q=${encodeURIComponent(c.name)}`} className="cn-link">View resources →</Link>
            <span className="cn-spacer" />
            <Menu c={c} onRename={() => setRenaming(true)} onRevoked={onRevoked} />
          </div>
        </>
      )}
    </article>
  );
}

/** A host fact the connector does not report: it needs the 2.25.0 run command (Update now). */
function Later({ on }: { on: boolean }) {
  return <span className="t-muted" title="Reported by connectors updated with the 2.25.0 command or later">{on ? "after the next update" : "—"}</span>;
}

export function latency(ms: number): string {
  return ms < 10 ? `${ms.toFixed(1)} ms` : `${Math.round(ms)} ms`;
}

function Spark({ values }: { values: number[] }) {
  const v = values.length ? values : [0];
  const max = Math.max(1, ...v);
  return (
    <span className="cn-spark" aria-hidden="true">
      {v.map((n, i) => <i key={i} style={{ height: `${Math.max(8, (n / max) * 100)}%` }} className={n ? undefined : "zero"} />)}
    </span>
  );
}

function Strip({ days }: { days: ConnectorCard["uptime"]["days"] }) {
  const label: Record<DayState, string> = { ok: "Healthy", warn: "Degraded", bad: "Outage", none: "No data" };
  return (
    <div className="cn-strip">
      <div className="cn-strip-head">
        <span>30-day availability</span>
        <span className="cn-legend"><i className="ok" />Healthy<i className="warn" />Degraded<i className="bad" />Outage<i className="none" />No data</span>
      </div>
      <div className="cn-bars">
        {days.map((d) => (
          <i key={d.date} className={d.state} title={`${d.date} · ${label[d.state]}${d.minutes ? ` · ${duration(d.minutes * 60)} down` : ""}`} />
        ))}
      </div>
      <div className="cn-axis"><span>30 days ago</span><span>Today</span></div>
    </div>
  );
}

function Rename({ id, name, done }: { id: string; name: string; done: () => void }) {
  const router = useRouter();
  const [v, setV] = useState(name);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function save() {
    const t = v.trim();
    if (!t) return setErr("Name can't be empty.");
    if (t === name) return done();
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/connectors/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: t }) });
      const r = (await res.json().catch(() => ({}))) as { ok?: boolean };
      if (res.ok && r.ok) { router.refresh(); done(); return; }
      setErr("Couldn't rename, please try again.");
    } catch {
      setErr("Couldn't rename, please try again.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="cn-rename">
      <input className="input" value={v} maxLength={100} autoFocus aria-label="Connector name" onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") void save(); if (e.key === "Escape") done(); }} />
      <button type="button" className="btn sm primary" disabled={busy} onClick={save}>{busy ? "Saving…" : "Save"}</button>
      <button type="button" className="btn sm" disabled={busy} onClick={done}>Cancel</button>
      {err && <span className="t-bad cn-rename-err" role="alert">{err}</span>}
    </div>
  );
}

function Menu({ c, onRename, onRevoked }: { c: ConnectorCard; onRename: () => void; onRevoked: () => void }) {
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = () => { setOpen(false); setConfirm(false); setErr(false); };
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) close(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey); };
  }, [open]);
  async function revoke() {
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/connectors?id=${encodeURIComponent(c.id)}`, { method: "DELETE" });
      const r = (await res.json().catch(() => ({}))) as { ok?: boolean };
      if (res.ok && r.ok) { setOpen(false); onRevoked(); return; }
    } catch { /* fall through */ }
    setBusy(false);
    setErr(true);
  }
  return (
    <div className="rs-menu" ref={ref}>
      <button type="button" className="btn sm rs-more" aria-label={`More actions for ${c.name}`} aria-expanded={open} onClick={() => { setOpen((v) => !v); setConfirm(false); }}>⋯</button>
      {open && (
        <div className="rs-menu-pop cn-menu-pop">
          <button type="button" className="rs-mi" onClick={() => { setOpen(false); onRename(); }}>Rename</button>
          <Link href={`/admin/connectors/${c.id}`} className="rs-mi">Settings &amp; logs</Link>
          <hr />
          {confirm ? (
            <>
              <button type="button" className="rs-mi danger-solid" disabled={busy} onClick={revoke}>{busy ? "Revoking…" : "Click again to revoke"}</button>
              <p className="cn-warn">{err ? "Couldn't revoke, please try again." : `${c.resources ? `${c.resources} resource${c.resources === 1 ? "" : "s"} and all tunnels close` : "All tunnels close"} at once. Bringing it back needs a new pairing.`}</p>
            </>
          ) : (
            <button type="button" className="rs-mi danger" onClick={() => setConfirm(true)}>Revoke access</button>
          )}
        </div>
      )}
    </div>
  );
}
