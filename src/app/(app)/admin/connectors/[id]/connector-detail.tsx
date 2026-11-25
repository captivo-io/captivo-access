"use client";
import { CleanupHostButton } from "../cleanup-host";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { NavIcon } from "@/app/(app)/_shell/nav-icons";
import { ResourceIcon } from "@/components/resource-icon";
import type { SiteTile } from "@/lib/access/grant-rows";
import type { ConnectorTelemetry } from "@/lib/connector/telemetry";
import type { ActivityRow } from "@/lib/connector/activity";
import { logRows, parseLogLine, type LevelFilter } from "@/lib/connector/log-lines";
import { parseTargets, type TargetKind } from "@/lib/connector/egress-targets";
import { fmt, hm, useZone } from "@/app/(app)/admin/audit/audit-zone";
import { ago, duration, latency } from "../connectors-view";
import { programUninstallCommand, programUpdateCommand } from "@/lib/connector/standalone";
import { HostActionBand, NoUpdaterBand, RemoveFromHostButton, UpdateConnectorButton, type UpdateCommands } from "../remote-control";
import { liveHostAction, remoteControl, updateTarget, type StoredHostAction } from "@/lib/connector/host-action";
import { isConnectorOutdated } from "@/lib/updates/semver";
import { RepairConnectorButton } from "../repair-connector-button";
import type { Tab } from "./tabs";
import { SSH_CA_MIN_CONNECTOR } from "@/lib/vault/providers";
import { CopyButton } from "@/app/(app)/_shell/copy-button";

type Tele = { online: boolean; ageMs?: number; telemetry?: ConnectorTelemetry | null; status?: string; lastSeenAt?: string | null; version?: string | null; hostAction?: StoredHostAction | null };
type Res = { tile: SiteTile; publicHost: string | null; ok: boolean | null; latencyMs: number | null; detail: string | null };
type Conn = {
  id: string; name: string; status: string; version: string | null; outdated: boolean; mgr: string;
  lastSeenAt: string | null; remoteAddr: string | null; createdAt: string; egressPolicy: string; logLevel: string; sshCaPublicKey: string | null;
  hostAction: StoredHostAction | null;
  platform: string | null;
};
type Sample = { at: number; active: number; total: number; uptime: number; denied: number; bin: number; bout: number };
type Source = "connector" | "guacd" | "kasm";

const POLL_MS = 10_000;
const SPARK = 20;
const TAB_LABEL: Record<Tab, string> = { overview: "Overview", resources: "Resources", logs: "Logs", activity: "Activity", settings: "Settings" };
const SOURCES: { key: Source; label: string; sub: string; field: "recentLogs" | "guacdLogs" | "kasmLogs" }[] = [
  { key: "connector", label: "Connector", sub: "captivo-connector · last lines", field: "recentLogs" },
  { key: "guacd", label: "Gateway", sub: "guacd · remote-desktop engine", field: "guacdLogs" },
  { key: "kasm", label: "Isolated browser", sub: "KasmVNC · isolated browser engine", field: "kasmLogs" },
];
const KIND_LABEL: Record<TargetKind, string> = { cidr: "CIDR", hp: "HOST:PORT", host: "HOST", ip: "IP" };
const LEVELS = ["", "debug", "info", "warn", "error"] as const;
const LEVEL_SUB: Record<string, string> = {
  "": "Follows the fleet default on the Policy page.",
  debug: "Logs every request. Verbose; for short troubleshooting only.",
  info: "Explicitly Info for this connector.",
  warn: "Warnings and errors only.",
  error: "Errors only; troubleshooting gets harder.",
};
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function sampleOf(t: ConnectorTelemetry, at: number): Sample {
  return { at, active: t.activeConnections, total: t.totalConnections, uptime: t.uptimeSec, denied: t.deniedCount, bin: t.bytesIn, bout: t.bytesOut };
}
function fmtBytes(n: number): string {
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${i ? n.toFixed(1) : Math.round(n)} ${u[i]}`;
}
function initials(s: string): string {
  const p = s.replace(/@.*/, "").split(/[\s._-]+/).filter(Boolean);
  return ((p[0]?.[0] ?? "?") + (p[1]?.[0] ?? "")).toUpperCase();
}

export function ConnectorDetail({ c, tele0, sites, activity, auditHref, defaultLogLevel, updateCommand, managerUrlIsLocal, serverNow, initialTab, workspace }: {
  c: Conn; tele0: Tele; sites: Res[]; activity: ActivityRow[]; auditHref: string; defaultLogLevel: string;
  updateCommand: UpdateCommands; managerUrlIsLocal: boolean; serverNow: number; initialTab: Tab; workspace: string;
}) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const [tele, setTele] = useState<Tele>(tele0);
  const [fetchedAt, setFetchedAt] = useState(serverNow);
  const [now, setNow] = useState(serverNow);
  const [samples, setSamples] = useState<Sample[]>(() => (tele0.online && tele0.telemetry ? [sampleOf(tele0.telemetry, serverNow)] : []));
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);

  // Live counters and log tails, every 10 s while the tab is visible.
  useEffect(() => {
    let stop = false;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    const poll = setInterval(async () => {
      if (document.hidden) return;
      const r = await fetch(`/api/admin/connectors/${c.id}/telemetry`, { cache: "no-store" }).catch(() => null);
      if (!r?.ok || stop) return;
      const t = (await r.json().catch(() => null)) as Tele | null;
      if (!t || stop) return;
      const at = Date.now();
      setTele(t);
      setFetchedAt(at);
      if (t.online && t.telemetry) setSamples((s) => [...s, sampleOf(t.telemetry as ConnectorTelemetry, at)].slice(-(SPARK + 1)));
    }, POLL_MS);
    return () => { stop = true; clearInterval(tick); clearInterval(poll); };
  }, [c.id]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3200);
    return () => clearTimeout(t);
  }, [toast]);

  function go(t: Tab) {
    setTab(t);
    window.history.replaceState(null, "", t === "overview" ? window.location.pathname : `?tab=${t}`);
  }

  const status = tele.status ?? c.status;
  const online = status === "ONLINE" && tele.online;
  const revoked = status === "REVOKED";
  const t = tele.online ? tele.telemetry ?? null : null;
  const lastSeen = tele.lastSeenAt ?? c.lastSeenAt;
  const signal = tele.online ? fetchedAt - (tele.ageMs ?? 0) : lastSeen ? Date.parse(lastSeen) : null;
  const pill = revoked ? ["bad", "Revoked"] : online ? ["ok", "Online"] : status === "PENDING" ? ["warn", "Waiting to connect"] : ["off", "Offline"];

  const down = sites.filter((s) => s.ok === false);
  const settings = useSettings(c);
  // Live: an update from the console changes the version while the page is open.
  const version = t?.version ?? tele.version ?? c.version;
  const outdated = isConnectorOutdated(version, c.mgr);
  const remote = remoteControl(online, t, c.createdAt, now, c.platform);
  const stored = tele.hostAction ?? c.hostAction;
  const report = liveHostAction(t?.hostAction ?? null, stored, new Date(now));
  const updating = !!report && report.action === "update" && !["done", "rolled_back", "failed"].includes(report.state);

  return (
    <div className="cd">
      <Link href="/admin/connectors" className="cd-back">← All connectors</Link>

      <div className="cd-head">
        <span className={online ? "cn-tile cd-tile" : "cn-tile cd-tile off"}><NavIcon name="plug" size={26} />{online && <i className="cn-live" aria-hidden="true" />}</span>
        <div className="cd-id">
          <span className="cd-eyebrow mono">INFRASTRUCTURE{workspace ? ` · ${workspace.toUpperCase()}` : ""}</span>
          <span className="cd-title"><h1>{c.name}</h1><span className={`cd-pill ${pill[0]}`}><i aria-hidden="true" />{pill[1]}</span></span>
          <span className="cd-meta mono">
            <span>{c.id}</span>
            {t?.hostname && <span>{t.hostname}</span>}
            {c.remoteAddr && <span>{c.remoteAddr}</span>}
            {signal != null && !revoked && <span>last seen {ago(now - signal)}</span>}
          </span>
        </div>
        <div className="cd-actions">
          {!revoked && <RepairConnectorButton id={c.id} className="btn cd-btn" />}
          <button type="button" className="btn cd-btn" onClick={() => go("logs")}><NavIcon name="list" size={15} />Logs</button>
        </div>
      </div>

      {!revoked && <HostActionBand connectorId={c.id} status={report} now={now} outdated={outdated} />}
      {outdated && !revoked && !updating && (
        <div className="cn-band warn">
          <span className="cn-chip mono">{version ?? "?"} → {c.mgr}</span>
          <span className="cn-band-t"><b>A new version is ready.</b> Updating keeps the token and pairing; sessions on it end while it restarts.</span>
          <a className="cn-notes" href={`https://github.com/captivo-io/captivo-access/releases/tag/v${c.mgr}`} target="_blank" rel="noreferrer">Release notes</a>
          <UpdateConnectorButton connectorId={c.id} commands={c.platform ? { remote: programUpdateCommand(c.platform), manual: programUpdateCommand(c.platform) } : updateCommand} managerUrlIsLocal={managerUrlIsLocal} remote={remote} target={updateTarget(version, c.mgr)}
            from={version} openTunnels={online ? (t?.activeConnections ?? 0) : 0} label={remote.ok ? "Update now" : "How to update"} className="btn sm ink" />
        </div>
      )}
      {!outdated && !revoked && !updating && (
        <NoUpdaterBand connectorId={c.id} commands={updateCommand} managerUrlIsLocal={managerUrlIsLocal} remote={remote} version={version} />
      )}
      {revoked && (
        <div className="cn-band bad">
          <span className="cn-band-t">
            {stored?.action === "uninstall"
              ? `Removed from its host from the console by ${stored.by}${stored.keepData ? "; its recordings and keys were left on the host" : ""}. If anything is left there, clean it up by hand.`
              : "This connector was revoked. Its tunnels are closed and it can't be re-paired; add a new connector instead."}
          </span>
          <CleanupHostButton />
        </div>
      )}

      <div className="cd-tabs" role="tablist" aria-label="Connector">
        {(Object.keys(TAB_LABEL) as Tab[]).map((k) => {
          const n = k === "resources" ? sites.length : k === "settings" ? settings.dirty : 0;
          const tone = k === "settings" ? "p" : k === "resources" && down.length ? "bad" : "";
          return (
            <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? "cd-tab on" : "cd-tab"} onClick={() => go(k)}>
              {TAB_LABEL[k]}{n > 0 && <span className={`cd-tab-n ${tone}`}>{n}</span>}
            </button>
          );
        })}
      </div>

      {tab === "overview" && (
        <div className="cd-pane">
          <Telemetry t={t} samples={samples} ageS={signal != null && tele.online ? Math.max(0, Math.round((now - signal) / 1000)) : null} />
          <div className="cd-two">
            <Identity c={{ ...c, version, outdated }} t={t} lastSeen={lastSeen} />
            <section className="cd-card">
              <CardHead icon="server" title="Resource health" sub={sites.length ? `${sites.length - down.length} reachable · ${down.length} unreachable` : "No resources on this connector yet"}>
                <button type="button" className="btn sm" onClick={() => go("resources")}>All →</button>
              </CardHead>
              <div className="cd-health">
                {sites.length > 0 && (
                  <span className="cd-hbar" aria-hidden="true">
                    <span className="ok" style={{ flex: sites.filter((s) => s.ok !== false).length }} />
                    {down.length > 0 && <span className="bad" style={{ flex: down.length }} />}
                  </span>
                )}
                {down.map((r) => (
                  <button key={r.tile.id} type="button" className="cd-down" onClick={() => go("resources")}>
                    <ResourceIcon name={r.tile.icon} color={r.tile.color} logoUrl={r.tile.logoUrl} logoBg={r.tile.logoBg} size={28} />
                    <span className="cd-down-t"><b>{r.tile.name}</b><span className="mono">{r.tile.host ?? "—"}</span></span>
                    <span className="cd-down-s">Unreachable</span>
                  </button>
                ))}
                {sites.length > 0 && down.length === 0 && <span className="cd-allok">Every resource answered its last check.</span>}
                {sites.length === 0 && <Link href="/admin/sites?new=1" className="cd-link">Add a resource →</Link>}
              </div>
            </section>
          </div>
        </div>
      )}

      {tab === "resources" && <Resources sites={sites} />}
      {tab === "logs" && <Logs name={c.name} t={t} online={online} onSettings={() => go("settings")} />}
      {tab === "activity" && <Activity rows={activity} auditHref={auditHref} />}
      {tab === "settings" && (
        <>
          <Settings s={settings} defaultLogLevel={defaultLogLevel} connectorId={c.id} onToast={setToast} caKey={c.sshCaPublicKey} />
          {!revoked && <RemoveCard c={c} resources={sites.length} remote={remote} />}
        </>
      )}

      {toast && <div className="toast" role="status"><span className={toast.ok ? undefined : "t-bad"}>{toast.ok ? "✓" : "!"}</span>{toast.msg}</div>}
    </div>
  );
}

function CardHead({ icon, title, sub, children }: { icon: "activity" | "server" | "shield" | "list"; title: string; sub: string; children?: React.ReactNode }) {
  return (
    <div className="cd-ch">
      <span className="cd-ch-ic"><NavIcon name={icon} size={16} /></span>
      <span className="cd-ch-t"><b>{title}</b><span>{sub}</span></span>
      {children}
    </div>
  );
}

function Telemetry({ t, samples, ageS }: { t: ConnectorTelemetry | null; samples: Sample[]; ageS: number | null }) {
  const last = samples[samples.length - 1];
  const first = samples[0];
  const span = last && first ? Math.max(1, Math.round((last.at - first.at) / 60_000)) : 0;
  const cells = t ? [
    { k: "active", label: "ACTIVE CONNECTIONS", value: String(t.activeConnections), sub: "right now", gauge: true },
    { k: "total", label: "TOTAL REQUESTS", value: t.totalConnections.toLocaleString("en-US"), sub: samples.length > 1 ? `+${(last.total - first.total).toLocaleString("en-US")} in ${span} min` : "since start", gauge: false },
    { k: "uptime", label: "UPTIME", value: duration(t.uptimeSec), sub: "since last restart", gauge: true },
    { k: "denied", label: "DENIED", value: t.deniedCount.toLocaleString("en-US"), sub: "since start", gauge: false, ok: t.deniedCount === 0 },
    { k: "bin", label: "BYTES IN", value: fmtBytes(t.bytesIn), sub: "since start", gauge: false },
    { k: "bout", label: "BYTES OUT", value: fmtBytes(t.bytesOut), sub: "since start", gauge: false },
  ] as const : [];
  return (
    <section className="cd-card">
      <CardHead icon="activity" title="Live telemetry" sub="Reported every 10 seconds while connected.">
        {t && ageS != null && <span className="cd-tick mono"><i aria-hidden="true" />updated {ageS}s ago</span>}
      </CardHead>
      {t ? (
        <div className="cd-tel">
          {cells.map((m) => (
            <div key={m.k} className="cd-tel-c">
              <span className="cd-tel-l mono">{m.label}</span>
              <span className={"ok" in m && m.ok ? "cd-tel-v ok" : "cd-tel-v"}>{m.value}</span>
              <Spark samples={samples} k={m.k as keyof Omit<Sample, "at">} gauge={m.gauge} tone={m.k === "uptime" ? "ok" : m.k === "bin" || m.k === "bout" ? "v" : "p"} />
              <span className="cd-tel-s">{m.sub}</span>
            </div>
          ))}
        </div>
      ) : (
        <p className="cd-empty">No live data: the connector is offline, or runs a version that doesn&apos;t report telemetry.</p>
      )}
    </section>
  );
}

/** The last 20 polls since this page opened; counters show the change between polls. Nothing is made up before that. */
function Spark({ samples, k, gauge, tone }: { samples: Sample[]; k: keyof Omit<Sample, "at">; gauge: boolean; tone: string }) {
  const vals = gauge
    ? samples.slice(-SPARK).map((s) => s[k])
    : samples.slice(-(SPARK + 1)).map((s, i, a) => (i ? Math.max(0, s[k] - a[i - 1][k]) : -1)).slice(1);
  const max = Math.max(1, ...vals);
  const pad = SPARK - vals.length;
  return (
    <span className={`cd-spark ${tone}`} aria-hidden="true" title={vals.length < 2 ? "Filling in from this page's polls" : undefined}>
      {Array.from({ length: pad }, (_, i) => <i key={`p${i}`} className="none" />)}
      {vals.map((v, i) => <i key={i} className={v ? undefined : "zero"} style={v ? { height: `${Math.max(12, (v / max) * 100)}%` } : undefined} />)}
    </span>
  );
}

function Identity({ c, t, lastSeen }: { c: Conn; t: ConnectorTelemetry | null; lastSeen: string | null }) {
  const zone = useZone();
  const when = (iso: string) => fmt(iso, zone, { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
  const rows: [string, string, React.ReactNode?][] = [
    ["Version", c.version ?? "—", c.version ? <span className={c.outdated ? "cd-kv-chip warn" : "cd-kv-chip ok"}>{c.outdated ? "Outdated" : "Latest"}</span> : null],
    ["Last seen", lastSeen ? when(lastSeen) : "Never"],
    ["Remote address", c.remoteAddr ?? "—"],
    ["Connector ID", c.id],
    ["Host", [t?.hostname, t?.os, t?.localIp].filter(Boolean).join(" · ") || "—"],
    ["Paired", fmt(c.createdAt, zone, { day: "numeric", month: "short", year: "numeric" })],
  ];
  return (
    <section className="cd-card">
      <CardHead icon="server" title="Identity" sub="What the connector reports about itself." />
      {rows.map(([k, v, chip]) => (
        <div key={k} className="cd-kv"><span>{k}</span><span className="cd-kv-v"><span className="mono">{v}</span>{chip}</span></div>
      ))}
    </section>
  );
}

function Health({ ok }: { ok: boolean | null }) {
  const [cls, label] = ok == null ? ["off", "Not checked"] : ok ? ["ok", "Reachable"] : ["bad", "Unreachable"];
  return <span className={`cd-pill sm ${cls}`}><i aria-hidden="true" />{label}</span>;
}

function Resources({ sites }: { sites: Res[] }) {
  const rows = [...sites].sort((a, b) => Number(b.ok === false) - Number(a.ok === false) || a.tile.name.localeCompare(b.tile.name));
  return (
    <section className="cd-card cd-pane">
      {rows.length === 0 ? (
        <p className="cd-empty">No resources on this connector yet. <Link href="/admin/sites?new=1" className="cd-link">Add a resource →</Link></p>
      ) : (
        <div className="cd-scroll">
          <div className="cd-grid cd-res head mono"><span>RESOURCE</span><span>ADDRESS</span><span>HEALTH</span><span className="r">LATENCY</span></div>
          {rows.map((r) => (
            <div key={r.tile.id} className={r.ok === false ? "cd-grid cd-res bad" : "cd-grid cd-res"} title={r.ok === false && r.detail ? r.detail : undefined}>
              <span className="cd-res-n">
                <ResourceIcon name={r.tile.icon} color={r.tile.color} logoUrl={r.tile.logoUrl} logoBg={r.tile.logoBg} size={32} />
                <span><Link href={`/admin/sites/${r.tile.id}/edit`}>{r.tile.name}</Link><span className="mono t-muted">{r.tile.proto}</span></span>
              </span>
              <span className="cd-res-a">
                {r.publicHost ? <span className="mono">{r.publicHost}</span> : <span className="t-muted">Only through Captivo</span>}
                <span className="mono t-muted">→ {r.tile.host ?? "—"}</span>
              </span>
              <span><Health ok={r.ok} /></span>
              <span className={r.ok === false ? "mono r t-bad" : "mono r"}>{r.latencyMs != null && r.ok !== false ? latency(r.latencyMs) : "—"}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function Logs({ name, t, online, onSettings }: { name: string; t: ConnectorTelemetry | null; online: boolean; onSettings: () => void }) {
  const [src, setSrc] = useState<Source>("connector");
  const [lv, setLv] = useState<LevelFilter>("all");
  const [q, setQ] = useState("");
  const [paused, setPaused] = useState<Record<Source, string[]> | null>(null);

  const live: Record<Source, string[]> = { connector: t?.recentLogs ?? [], guacd: t?.guacdLogs ?? [], kasm: t?.kasmLogs ?? [] };
  const lines = paused ?? live;
  const raw = lines[src];
  const parsed = useMemo(() => raw.map(parseLogLine), [raw]);
  const hasErr = (s: Source) => lines[s].some((l) => parseLogLine(l).level === "ERROR");
  const nWarn = parsed.filter((l) => l.level === "WARN" || l.level === "ERROR").length;
  const nErr = parsed.filter((l) => l.level === "ERROR").length;
  const rows = useMemo(() => logRows(raw, lv, q), [raw, lv, q]);
  const shown = rows.reduce((n, r) => n + r.count, 0);
  const meta = SOURCES.find((s) => s.key === src)!;

  function download() {
    const keep = new Set(rows.map((r) => `${r.level}\u0000${r.msg}`));
    const text = raw.filter((l) => { const p = parseLogLine(l); return keep.has(`${p.level}\u0000${p.msg}`); }).join("\n") + "\n";
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    a.download = `${name.replace(/[^\w.-]+/g, "-").toLowerCase()}-${src}.log`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  return (
    <section className="cd-card cd-pane cd-logs">
      <div className="cd-logbar">
        <div className="seg" role="radiogroup" aria-label="Source">
          {SOURCES.map((s) => (
            <button key={s.key} type="button" role="radio" aria-checked={src === s.key} className={src === s.key ? "seg-opt on" : "seg-opt"} onClick={() => setSrc(s.key)}>
              {s.label}{hasErr(s.key) && <i className="cd-errdot" aria-label="has errors" />}
            </button>
          ))}
        </div>
        <label className="ma-search cd-logq">
          <NavIcon name="search" size={15} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search logs…" aria-label="Search logs" />
        </label>
        <div className="seg" role="radiogroup" aria-label="Level">
          {([["all", "All", 0], ["warn", "Warn+", nWarn], ["error", "Error", nErr]] as const).map(([k, label, n]) => (
            <button key={k} type="button" role="radio" aria-checked={lv === k} className={lv === k ? "seg-opt on" : "seg-opt"} onClick={() => setLv(k)}>
              {label}{n > 0 && <span className={k === "error" ? "cd-segn bad mono" : "cd-segn mono"}>{n}</span>}
            </button>
          ))}
        </div>
      </div>
      <div className="cd-term-h mono">
        <span className="cd-term-src"><i className={online && !paused ? "on" : undefined} aria-hidden="true" />{meta.sub}</span>
        <span className="cd-term-acts">
          <button type="button" aria-pressed={!paused} className={paused ? "cd-tbtn" : "cd-tbtn on"} onClick={() => setPaused(paused ? null : live)}>{paused ? "Paused" : "● Live"}</button>
          <button type="button" className="cd-tbtn" onClick={download} disabled={rows.length === 0}><NavIcon name="download" size={12} />.log</button>
        </span>
      </div>
      <div className="cd-term">
        <div>
          {rows.map((r, i) => (
            <div key={i} className={`cd-line ${r.level.toLowerCase()}`}>
              <span className="cd-line-t">{r.time || "—"}</span>
              <span className={`cd-lv ${r.level.toLowerCase()}`}>{r.level}</span>
              <span className="cd-line-m">{r.msg}{r.count > 1 && <span className="cd-rep">×{r.count}</span>}</span>
            </div>
          ))}
          {rows.length === 0 && (
            <span className="cd-term-empty">{raw.length ? "No lines match this filter." : !t ? "No lines: the connector is offline." : "Nothing reported from this source yet."}</span>
          )}
        </div>
      </div>
      <div className="cd-logfoot">
        <span>Showing {shown} of {raw.length} lines · the connector sends its latest 80 per source</span>
        <button type="button" className="link-button cd-link" onClick={onSettings}>Change log level →</button>
      </div>
    </section>
  );
}

function Activity({ rows, auditHref }: { rows: ActivityRow[]; auditHref: string }) {
  const zone = useZone();
  const [f, setF] = useState<"all" | "allow" | "deny">("all");
  const shown = rows.filter((r) => f === "all" || (f === "allow") === r.allow);
  const nDeny = rows.filter((r) => !r.allow).length;
  return (
    <div className="cd-pane cd-act">
      <div className="cd-actbar">
        <div className="seg" role="radiogroup" aria-label="Decision">
          {([["all", "All", rows.length], ["allow", "Allowed", rows.length - nDeny], ["deny", "Denied", nDeny]] as const).map(([k, label, n]) => (
            <button key={k} type="button" role="radio" aria-checked={f === k} className={f === k ? "seg-opt on" : "seg-opt"} onClick={() => setF(k)}>
              {label}<span className={k === "deny" && n ? "cd-segn bad mono" : "cd-segn mono"}>{n}</span>
            </button>
          ))}
        </div>
        <span className="cd-spacer" />
        <Link href={auditHref} className="btn sm">Open in Audit →</Link>
      </div>
      <section className="cd-card">
        {shown.length === 0 ? (
          <p className="cd-empty">{rows.length ? "Nothing matches this filter." : "No access activity on this connector's resources yet."}</p>
        ) : (
          <div className="cd-scroll">
            <div className="cd-grid cd-arow head mono"><span>TIME</span><span>USER</span><span>RESOURCE</span><span>REQUEST</span><span>DECISION</span></div>
            {shown.map((r) => (
              <div key={r.id} className={r.allow ? "cd-grid cd-arow" : "cd-grid cd-arow bad"}>
                <span className="mono t-muted">{hm(r.at, zone)}</span>
                <span className="cd-au"><span className="cd-av" aria-hidden="true">{initials(r.user)}</span><span className="cd-ell">{r.user}</span></span>
                <span className="cd-ell cd-asite">{r.siteName}</span>
                <span className="cd-areq"><span className="cd-method mono">{r.method}</span><span className="mono cd-ell">{r.path}</span>{r.count > 1 && <span className="cd-rep2 mono">×{r.count}</span>}</span>
                <span><span className={r.allow ? "cd-pill sm ok" : "cd-pill sm bad"}><i aria-hidden="true" />{r.allow ? "Allowed" : "Denied"}</span></span>
              </div>
            ))}
          </div>
        )}
      </section>
      <span className="cd-note">Identical requests in the same minute are merged (×n). The latest 50 are shown; full history is on the Audit page.</span>
    </div>
  );
}

type SettingsState = ReturnType<typeof useSettings>;

function useSettings(c: Conn) {
  const [eg0, setEg0] = useState(c.egressPolicy);
  const [eg, setEg] = useState(c.egressPolicy);
  const [lg0, setLg0] = useState(c.logLevel);
  const [lg, setLg] = useState(c.logLevel);
  const parsed = useMemo(() => parseTargets(eg), [eg]);
  const egChanged = parsed.normalized !== parseTargets(eg0).normalized;
  const lgChanged = lg !== lg0;
  return {
    eg, setEg, lg, setLg, parsed, egChanged, lgChanged,
    dirty: Number(egChanged) + Number(lgChanged),
    undo: () => { setEg(eg0); setLg(lg0); },
    saved: (egress: string, level: string) => { setEg0(egress); setEg(egress); setLg0(level); setLg(level); },
  };
}

function Settings({ s, defaultLogLevel, connectorId, onToast, caKey }: { s: SettingsState; defaultLogLevel: string; connectorId: string; onToast: (t: { msg: string; ok: boolean }) => void; caKey: string | null }) {
  const [busy, setBusy] = useState(false);
  const bad = s.parsed.invalid.length > 0;
  const n = s.parsed.targets.length;

  async function save() {
    setBusy(true);
    try {
      const body: Record<string, string> = {};
      if (s.egChanged) body.egressAllowedTargets = s.eg;
      if (s.lgChanged) body.logLevel = s.lg;
      const res = await fetch(`/api/admin/connectors/${connectorId}/settings`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; live?: boolean; error?: string; invalid?: string[] };
      if (!res.ok || !j.ok) {
        onToast({ ok: false, msg: j.error === "invalid_targets" ? `Not a valid target: ${(j.invalid ?? []).join(", ")}` : "Couldn't save the settings." });
        return;
      }
      s.saved(s.parsed.normalized, s.lg);
      onToast({ ok: true, msg: j.live ? "Settings pushed to the connector" : "Saved · applied when the connector is next online" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="cd-pane cd-set">
      <section className="cd-card">
        <CardHead icon="shield" title="Egress policy" sub="Narrows what this connector may reach." />
        <div className="cd-setb">
          {s.egChanged && <span className="cd-gdot" aria-hidden="true" />}
          <span className="cd-hint">CIDR, host or host:port; separate with commas, spaces or new lines. It can only further restrict the connector&apos;s local <code>ALLOWED_TARGETS</code> ceiling. Applied live; no redeploy.</span>
          <textarea className={bad ? "cd-ta bad" : "cd-ta"} rows={3} value={s.eg} onChange={(e) => s.setEg(e.target.value)} placeholder="10.0.5.0/24, db.internal:5432" aria-label="Egress policy" aria-invalid={bad} spellCheck={false} />
          {n > 0 && (
            <div className="cd-chips">
              {s.parsed.targets.map((tg, i) => (
                <span key={`${tg.v}-${i}`} className={tg.kind ? "cd-tchip" : "cd-tchip bad"}><span>{tg.kind ? KIND_LABEL[tg.kind] : "?"}</span>{tg.v}</span>
              ))}
            </div>
          )}
          <span className={bad ? "cd-egst bad" : n ? "cd-egst ok" : "cd-egst"}>
            {bad ? `Invalid: ${s.parsed.invalid.join(", ")}` : n ? `${n} ${n === 1 ? "target" : "targets"} · valid` : "No extra restriction · the connector's own ceiling applies."}
          </span>
        </div>
      </section>
      <section className="cd-card">
        <CardHead icon="list" title="Log level" sub="Pushed live over the control stream." />
        <div className="cd-setb">
          {s.lgChanged && <span className="cd-gdot" aria-hidden="true" />}
          <div className="seg cd-lvseg" role="radiogroup" aria-label="Log level">
            {LEVELS.map((l) => (
              <button key={l} type="button" role="radio" aria-checked={s.lg === l} className={s.lg === l ? "seg-opt on" : "seg-opt"} onClick={() => s.setLg(l)}>
                {l ? cap(l) : `Default (${cap(defaultLogLevel)})`}
              </button>
            ))}
          </div>
          <span className={s.lg === "debug" || s.lg === "error" ? "cd-egst warn" : "cd-egst"}>{LEVEL_SUB[s.lg] ?? ""}</span>
        </div>
      </section>
      <section className="cd-card">
        <CardHead icon="shield" title="SSH certificate authority" sub="Servers that trust it accept this connector's short-lived certificates, with no password or key." />
        <div className="cd-setb">
          {caKey ? (
            <div className="rf-code"><pre className="mono">{caKey}</pre><CopyButton value={caKey} /></div>
          ) : (
            <span className="cd-hint">Not reported yet: it appears once this connector runs {SSH_CA_MIN_CONNECTOR} or later and is online.</span>
          )}
          <span className="cd-hint">Put this line in the SSH server&apos;s <span className="mono">TrustedUserCAKeys</span> file. A resource uses it when its sign-in is set to SSH certificate.</span>
        </div>
      </section>
      {s.dirty > 0 && (
        <div className="pol-bar" role="region" aria-label="Unsaved changes">
          <span className="pol-bar-dot" aria-hidden="true" />
          <span className="pol-bar-n">{s.dirty} unsaved {s.dirty === 1 ? "change" : "changes"}</span>
          <button type="button" className="pol-bar-b" disabled={busy} onClick={s.undo}>Undo</button>
          <button type="button" className="pol-bar-b primary" disabled={busy || bad} onClick={() => void save()}>{busy ? "Sending…" : "Push to connector"}</button>
        </div>
      )}
    </div>
  );
}

function RemoveCard({ c, resources, remote }: { c: Conn; resources: number; remote: ReturnType<typeof remoteControl> }) {
  return (
    <div className="cd-pane cd-set">
      <section className="cd-card cd-danger">
        <CardHead icon="server" title="Remove from host" sub="Takes the connector, its session engines and the updater off the host, then revokes it here." />
        <div className="cd-setb">
          <span className="cd-hint">
            {remote.ok
              ? "Done by the updater on the host; nothing to run there. The recordings and their keys stay on the host unless you ask otherwise."
              : remote.reason === "offline"
                ? "Needs the connector online. While it is offline, revoke it and clean up the host by hand."
                : remote.reason === "installing"
                  ? "The updater on this host is still being installed (it starts last, after the images download); this works once it reports, in a few minutes."
                  : remote.reason === "program"
                    ? `This connector is installed as a program. On its host run ${programUninstallCommand(c.platform ?? "linux")} (add --keep-data to keep the keys and recordings), then revoke it here.`
                    : "This host has no updater. Revoke the connector and clean up the host by hand, or update it once with the command (it installs the updater)."}
          </span>
          <div><RemoveFromHostButton id={c.id} name={c.name} resources={resources} remote={remote} /></div>
        </div>
      </section>
    </div>
  );
}
