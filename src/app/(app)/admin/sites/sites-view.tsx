"use client";
import { useEffect, useMemo, useState } from "react";
import { textMatch } from "@/lib/table/filter";
import { EditSiteButton } from "./edit-site-button";
import { SiteAvatar } from "@/app/(app)/_shell/site-avatar";
import { TestConnectionButton } from "./test-connection-button";
import { DeleteSiteButton } from "./delete-site-button";
import { CopyButton } from "@/app/(app)/_shell/copy-button";
import { NavIcon } from "@/app/(app)/_shell/nav-icons";

export interface SiteRow {
  id: string;
  name: string;
  hostname: string;
  upstreamUrl: string | null;
  gatewayTarget: string | null;
  /** RDP / SSH / VNC / TELNET for a remote session; null otherwise. */
  protocol: string | null;
  description: string | null;
  accessMode: "TRANSPARENT" | "GATEWAY" | "ISOLATED";
  hasLogo: boolean;
  connectorId: string;
  insecureSkipVerify: boolean;
  recordSessions: boolean;
  clipboardMode: string | null;
  connectorName: string;
  connectorOnline: boolean;
  grantCount: number;
  probeOk: boolean | null;
  probeDetail: string | null;
  probeLatencyMs: number | null;
  probedAgo: string | null;
}

type View = "cards" | "list";
type TypeFilter = "all" | SiteRow["accessMode"];
type Health = "up" | "down" | "unknown";
type HealthFilter = "all" | Health;
type Sort = "attention" | "name" | "recent";
const STORE_KEY = "captivo:sites-view";

const TYPE: Record<SiteRow["accessMode"], { label: string; chip: string; tone: string }> = {
  TRANSPARENT: { label: "Web app", chip: "WEB APP", tone: "web" },
  GATEWAY: { label: "Remote session", chip: "REMOTE", tone: "remote" },
  ISOLATED: { label: "Isolated browser", chip: "ISOLATED", tone: "isolated" },
};

function healthState(s: SiteRow): Health {
  const noAddress = s.accessMode !== "GATEWAY" && s.upstreamUrl == null;
  if (noAddress || s.probeOk == null) return "unknown";
  return s.probeOk ? "up" : "down";
}

/**
 * Resources: a summary of what is published and whether it answers, then the
 * resources as cards (or a compact list) that can be searched, filtered by
 * kind and health, and sorted with what needs attention first.
 */
export function SitesView({
  sites,
  connectors,
  recordingEnabled,
}: {
  sites: SiteRow[];
  connectors: { id: string; name: string; vaultPublicKey?: string | null }[];
  recordingEnabled: boolean;
}) {
  const [view, setView] = useState<View>("cards");
  const [q, setQ] = useState("");
  const [type, setType] = useState<TypeFilter>("all");
  const [health, setHealth] = useState<HealthFilter>("all");
  const [sort, setSort] = useState<Sort>("attention");

  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORE_KEY);
      // eslint-disable-next-line react-hooks/set-state-in-effect -- the saved choice is only readable after mount
      if (saved === "cards" || saved === "list") setView(saved);
    } catch { /* ignore */ }
  }, []);
  function choose(v: View) {
    setView(v);
    try { localStorage.setItem(STORE_KEY, v); } catch { /* ignore */ }
  }

  const counts = useMemo(() => {
    const c = { total: sites.length, up: 0, down: 0, unknown: 0, TRANSPARENT: 0, GATEWAY: 0, ISOLATED: 0 };
    for (const s of sites) {
      c[healthState(s)]++;
      c[s.accessMode]++;
    }
    return c;
  }, [sites]);

  const shown = useMemo(() => {
    const rank: Record<Health, number> = { down: 0, unknown: 1, up: 2 };
    const list = sites.filter((s) =>
      (type === "all" || s.accessMode === type) &&
      (health === "all" || healthState(s) === health) &&
      textMatch([s.name, s.hostname, s.connectorName, s.upstreamUrl, s.gatewayTarget, s.description, s.protocol], q),
    );
    if (sort === "name") return [...list].sort((a, b) => a.name.localeCompare(b.name));
    if (sort === "attention") return [...list].sort((a, b) => rank[healthState(a)] - rank[healthState(b)] || a.name.localeCompare(b.name));
    return list; // the page lists the most recently added first
  }, [sites, type, health, q, sort]);

  const pickHealth = (h: HealthFilter) => setHealth((cur) => (cur === h ? "all" : h));
  const pickType = (t: TypeFilter) => setType((cur) => (cur === t ? "all" : t));

  return (
    <div className="rs">
      <div className="kstrip rs-summary" role="list">
        <SumCell label="Resources" value={counts.total} sub={`${counts.TRANSPARENT} web · ${counts.GATEWAY} remote · ${counts.ISOLATED} isolated`} on={health === "all" && type === "all"} onClick={() => { setHealth("all"); setType("all"); }} />
        <SumCell label="Reachable" value={counts.up} tone={counts.up > 0 ? "ok" : undefined} sub={counts.total > 0 ? `${Math.round((counts.up / counts.total) * 100)}% of all` : "none"} on={health === "up"} onClick={() => pickHealth("up")} />
        <SumCell label="Unreachable" value={counts.down} tone={counts.down > 0 ? "bad" : undefined} sub={counts.down > 0 ? "check the address or the connector" : "none"} on={health === "down"} onClick={() => pickHealth("down")} />
        <SumCell label="Not checked" value={counts.unknown} sub={counts.unknown > 0 ? "no health check yet" : "none"} on={health === "unknown"} onClick={() => pickHealth("unknown")} />
      </div>

      <div className="rs-tools">
        <label className="ma-search rs-search">
          <NavIcon name="search" size={16} />
          <input type="search" placeholder="Search name, host, address, connector…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search resources" />
        </label>
        <div className="seg" role="group" aria-label="Type">
          <button type="button" className={type === "all" ? "seg-opt on" : "seg-opt"} aria-pressed={type === "all"} onClick={() => setType("all")}>All</button>
          {(["TRANSPARENT", "GATEWAY", "ISOLATED"] as const).map((t) => (
            <button key={t} type="button" className={type === t ? "seg-opt on" : "seg-opt"} aria-pressed={type === t} onClick={() => pickType(t)}>
              {t === "TRANSPARENT" ? "Web app" : t === "GATEWAY" ? "Remote" : "Isolated"} <span className="rs-n">{counts[t]}</span>
            </button>
          ))}
        </div>
        <select className="select rs-sort" value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="Sort">
          <option value="attention">Needs attention first</option>
          <option value="name">Name</option>
          <option value="recent">Recently added</option>
        </select>
        <div className="seg rs-view" role="group" aria-label="View">
          <button type="button" className={view === "cards" ? "seg-opt on" : "seg-opt"} aria-pressed={view === "cards"} onClick={() => choose("cards")} title="Cards" aria-label="Cards"><NavIcon name="grid" size={16} /></button>
          <button type="button" className={view === "list" ? "seg-opt on" : "seg-opt"} aria-pressed={view === "list"} onClick={() => choose("list")} title="List" aria-label="List"><NavIcon name="list" size={16} /></button>
        </div>
      </div>

      {shown.length === 0 ? (
        <div className="card rs-none">
          <b>No resource matches</b>
          <span>Clear the search or the filters to see every resource.</span>
          <button type="button" className="btn sm" onClick={() => { setQ(""); setType("all"); setHealth("all"); }}>Clear filters</button>
        </div>
      ) : view === "cards" ? (
        <div className="rs-grid">
          {shown.map((s) => <ResourceCard key={s.id} s={s} connectors={connectors} recordingEnabled={recordingEnabled} />)}
        </div>
      ) : (
        <div className="table-wrap rs-list">
          <div className="rs-lrow rs-lhead" aria-hidden="true"><span>Resource</span><span>Internal address</span><span>Health</span><span /></div>
          {shown.map((s) => <ResourceRow key={s.id} s={s} connectors={connectors} recordingEnabled={recordingEnabled} />)}
        </div>
      )}
    </div>
  );
}

function SumCell({ label, value, sub, tone, on, onClick }: { label: string; value: number; sub: string; tone?: "ok" | "bad"; on: boolean; onClick: () => void }) {
  return (
    <button type="button" className={on ? "kcell rs-cell on" : "kcell rs-cell"} role="listitem" aria-pressed={on} onClick={onClick}>
      <span className="kcell-k">{label}</span>
      <span className="kcell-row">
        <span className={tone ? `kcell-v t-${tone}` : "kcell-v"}>{value}</span>
        <span className="kcell-s">{sub}</span>
      </span>
    </button>
  );
}

function TypeChip({ s }: { s: SiteRow }) {
  const t = TYPE[s.accessMode];
  return <span className={`rs-chip ${t.tone}`}>{t.chip}{s.protocol ? ` · ${s.protocol}` : ""}</span>;
}

function HealthBadge({ s }: { s: SiteRow }) {
  const h = healthState(s);
  const noAddress = s.accessMode !== "GATEWAY" && s.upstreamUrl == null;
  return (
    <span className="rs-health">
      <span className={`rs-dot ${h}`} aria-hidden="true" />
      <span className={h === "up" ? "t-ok" : h === "down" ? "t-bad" : "t-muted"}>
        {noAddress ? "No address" : h === "up" ? "Reachable" : h === "down" ? "Unreachable" : "Not checked"}
      </span>
      {h === "up" && s.probeLatencyMs != null && <span className="mono t-muted">{s.probeLatencyMs} ms</span>}
      {s.probedAgo && <span className="mono t-muted">· {s.probedAgo}</span>}
    </span>
  );
}

function Meta({ s }: { s: SiteRow }) {
  return (
    <span className="rs-meta">
      <span title={`Connector: ${s.connectorName}${s.connectorOnline ? "" : " (offline)"}`}>
        <NavIcon name="plug" size={14} /> {s.connectorName}{!s.connectorOnline && <span className="t-bad"> · offline</span>}
      </span>
      <span title="People with a grant"><NavIcon name="users" size={14} /> {s.grantCount}</span>
      {s.recordSessions && <span className="rs-rec" title="Sessions are recorded"><span className="rec-dot" aria-hidden="true" /> REC</span>}
    </span>
  );
}

function ResourceCard({ s, connectors, recordingEnabled }: { s: SiteRow; connectors: { id: string; name: string; vaultPublicKey?: string | null }[]; recordingEnabled: boolean }) {
  const internal = s.upstreamUrl ?? s.gatewayTarget;
  const h = healthState(s);
  return (
    <article className={`card rs-card h-${h}`}>
      <div className="rs-card-top">
        <SiteAvatar name={s.name} siteId={s.id} hasLogo={s.hasLogo} />
        <div className="rs-card-id">
          <b title={s.name}>{s.name}</b>
          <TypeChip s={s} />
        </div>
      </div>
      <dl className="rs-addr">
        {s.hostname && (
          <div><dt>Address</dt><dd><span className="mono" title={s.hostname}>{s.hostname}</span><CopyButton value={s.hostname} label="Copy" /></dd></div>
        )}
        <div><dt>Internal</dt><dd>{internal ? <><span className="mono" title={internal}>{internal}</span><CopyButton value={internal} label="Copy" /></> : <span className="t-muted">No internal address</span>}</dd></div>
      </dl>
      <div className="rs-card-health">
        <HealthBadge s={s} />
        {h === "down" && s.probeDetail && <span className="rs-detail">{s.probeDetail}</span>}
      </div>
      {s.description && <p className="rs-desc">{s.description}</p>}
      <div className="rs-card-foot">
        <Meta s={s} />
        <div className="rs-acts">
          <TestConnectionButton siteId={s.id} />
          <EditSiteButton site={s} connectors={connectors} recordingEnabled={recordingEnabled} />
          <DeleteSiteButton id={s.id} name={s.name} grantCount={s.grantCount} />
        </div>
      </div>
    </article>
  );
}

function ResourceRow({ s, connectors, recordingEnabled }: { s: SiteRow; connectors: { id: string; name: string; vaultPublicKey?: string | null }[]; recordingEnabled: boolean }) {
  const internal = s.upstreamUrl ?? s.gatewayTarget;
  return (
    <div className={`rs-lrow h-${healthState(s)}`}>
      <span className="rs-lres">
        <SiteAvatar name={s.name} siteId={s.id} hasLogo={s.hasLogo} />
        <span className="rs-lres-t">
          <span className="rs-lname"><b>{s.name}</b><TypeChip s={s} /></span>
          {s.hostname && <span className="mono t-muted rs-lhost">{s.hostname}</span>}
        </span>
      </span>
      <span className="rs-laddr">
        {internal ? <span className="mono" title={internal}>{internal}</span> : <span className="t-muted">No internal address</span>}
        <Meta s={s} />
      </span>
      <span><HealthBadge s={s} /></span>
      <span className="rs-acts">
        <TestConnectionButton siteId={s.id} />
        <EditSiteButton site={s} connectors={connectors} recordingEnabled={recordingEnabled} />
        <DeleteSiteButton id={s.id} name={s.name} grantCount={s.grantCount} />
      </span>
    </div>
  );
}
