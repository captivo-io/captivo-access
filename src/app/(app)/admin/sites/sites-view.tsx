"use client";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { textMatch } from "@/lib/table/filter";
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
type Status = "all" | "up" | "down";
type Kind = "all" | "web" | "remote";
type Health = "up" | "down" | "testing" | "unknown";
type Live = Record<string, { testing?: boolean; ok?: boolean; latencyMs?: number | null; at?: number }>;
const STORE_KEY = "captivo:sites-view";

/** HTTPS / HTTP for a web app or isolated browser, the session protocol for a remote one. */
function protocolOf(s: SiteRow): string {
  if (s.accessMode === "GATEWAY") return s.protocol ?? "REMOTE";
  const u = s.upstreamUrl ?? "";
  return u.startsWith("http://") ? "HTTP" : "HTTPS";
}
const isRemote = (s: SiteRow) => s.accessMode === "GATEWAY";
const target = (s: SiteRow) => s.upstreamUrl ?? (s.gatewayTarget ? `${(s.protocol ?? "").toLowerCase() || "tcp"}://${s.gatewayTarget}` : null);
const stripScheme = (u: string) => u.replace(/^[a-z]+:\/\//i, "").replace(/\/$/, "");
function targetHost(s: SiteRow): string | null {
  const t = target(s);
  if (!t) return null;
  try {
    return new URL(t.includes("://") ? t : `x://${t}`).hostname || null;
  } catch {
    return stripScheme(t).split(/[:/]/)[0] || null;
  }
}

/**
 * Resources, as the design hand-off (README 7.6) lays them out: the KPI strip,
 * a hint when several unreachable resources share a host, search and filters,
 * and cards that draw the tunnel (Edge, connector, target) with a live test.
 */
export function SitesView({
  sites,
  hostSuffix,
}: {
  sites: SiteRow[];
  connectors: { id: string; name: string; vaultPublicKey?: string | null }[];
  recordingEnabled: boolean;
  /** ".acme.cloud.captivo.io": a web resource's public address is its label plus this. */
  hostSuffix: string | null;
}) {
  const router = useRouter();
  const [view, setView] = useState<View>("cards");
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<Status>("all");
  const [kind, setKind] = useState<Kind>("all");
  const [live, setLive] = useState<Live>({});
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
  const [testingAll, setTestingAll] = useState(false);
  // "Test all" sits in the page header, beside "Add resource" (a server render).
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- the header slot exists only after mount
  useEffect(() => { setSlot(document.getElementById("rs-head-actions")); }, []);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORE_KEY);
      // eslint-disable-next-line react-hooks/set-state-in-effect -- the saved choice is only readable after mount
      if (saved === "cards" || saved === "list") setView(saved);
    } catch { /* ignore */ }
  }, []);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2600);
    return () => clearTimeout(t);
  }, [toast]);
  function choose(v: View) {
    setView(v);
    try { localStorage.setItem(STORE_KEY, v); } catch { /* ignore */ }
  }

  const health = (s: SiteRow): Health => {
    const l = live[s.id];
    if (l?.testing) return "testing";
    const ok = l?.ok ?? s.probeOk;
    if (ok == null) return "unknown";
    return ok ? "up" : "down";
  };
  const latency = (s: SiteRow) => (live[s.id]?.latencyMs !== undefined ? live[s.id]?.latencyMs : s.probeLatencyMs) ?? null;
  const checked = (s: SiteRow) => (live[s.id]?.at ? "just now" : s.probedAgo);
  const publicHost = (s: SiteRow) => (!isRemote(s) && s.hostname ? `${s.hostname}${hostSuffix ?? ""}` : null);

  async function test(s: SiteRow): Promise<boolean | null> {
    setLive((m) => ({ ...m, [s.id]: { ...m[s.id], testing: true } }));
    let ok: boolean | null = null;
    let ms: number | null = null;
    try {
      const res = await fetch(`/api/admin/sites/${s.id}/test`, { method: "POST" });
      const b = (await res.json().catch(() => ({}))) as { ok?: boolean; latencyMs?: number; status?: number; error?: string };
      ok = b.ok === true || typeof b.status === "number" ? true : false;
      ms = typeof b.latencyMs === "number" ? b.latencyMs : null;
    } catch {
      ok = false;
    }
    setLive((m) => ({ ...m, [s.id]: { testing: false, ok: ok ?? false, latencyMs: ms, at: Date.now() } }));
    return ok;
  }
  async function testOne(s: SiteRow) {
    const ok = await test(s);
    setToast(ok ? { msg: `${s.name} is reachable`, ok: true } : { msg: `${s.name} did not answer`, ok: false });
    router.refresh();
  }
  async function testAll() {
    setTestingAll(true);
    let up = 0;
    for (const s of sites) {
      if (await test(s)) up++;
      await new Promise((r) => setTimeout(r, 120)); // staggered, not a burst through one tunnel
    }
    setTestingAll(false);
    setToast({ msg: `Tested ${sites.length} resources: ${up} reachable, ${sites.length - up} unreachable`, ok: up === sites.length });
    router.refresh();
  }

  const counts = useMemo(() => {
    let up = 0, down = 0, lat = 0, latN = 0;
    for (const s of sites) {
      const h = health(s);
      if (h === "up") {
        up++;
        const l = latency(s);
        if (l != null) { lat += l; latN++; }
      } else if (h === "down") down++;
    }
    const connectors = new Set(sites.map((s) => s.connectorId)).size;
    return { total: sites.length, up, down, avg: latN ? lat / latN : null, connectors };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- health/latency read `live`, listed here
  }, [sites, live]);

  // Several unreachable resources behind one host: the host is the likely cause.
  const hint = useMemo(() => {
    const by = new Map<string, number>();
    for (const s of sites) {
      if (health(s) !== "down") continue;
      const h = targetHost(s);
      if (h) by.set(h, (by.get(h) ?? 0) + 1);
    }
    let best: { host: string; n: number } | null = null;
    for (const [host, n] of by) if (n >= 2 && (!best || n > best.n)) best = { host, n };
    return best;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- health reads `live`, listed here
  }, [sites, live]);

  const shown = sites.filter((s) => {
    const h = health(s);
    if (status === "up" && h !== "up") return false;
    if (status === "down" && h !== "down") return false;
    if (kind === "web" && isRemote(s)) return false;
    if (kind === "remote" && !isRemote(s)) return false;
    return textMatch([s.name, publicHost(s), s.connectorName, target(s), s.description, s.protocol], q);
  });
  const avg = counts.avg == null ? "—" : counts.avg < 10 ? counts.avg.toFixed(1) : String(Math.round(counts.avg));
  const ctx = { health, latency, checked, publicHost, testOne, onDeleted: (n: string) => { setToast({ msg: `${n} deleted`, ok: true }); router.refresh(); } };

  return (
    <div className="rs">
      {slot && createPortal(
        <button type="button" className="btn" onClick={testAll} disabled={testingAll || sites.length === 0}>
          <RefreshIcon spin={testingAll} /> {testingAll ? "Testing…" : "Test all"}
        </button>,
        slot,
      )}

      <div className="kstrip rs-summary" role="list">
        <SumCell dot="muted" label="Total" value={String(counts.total)} sub={`${counts.connectors} connector${counts.connectors === 1 ? "" : "s"}`} on={status === "all"} onClick={() => setStatus("all")} />
        <SumCell dot="ok" label="Reachable" value={String(counts.up)} sub="tunnel healthy" on={status === "up"} onClick={() => setStatus("up")} />
        <SumCell dot="bad" label="Unreachable" value={String(counts.down)} sub={counts.down ? "needs attention" : "none"} on={status === "down"} onClick={() => setStatus("down")} />
        <SumCell dot="p" label="Avg latency" value={avg} unit={counts.avg == null ? "" : "ms"} sub="latest tests" on={false} />
      </div>

      {hint && !q && (
        <div className="rs-hint" role="status">
          <span className="rs-hint-ic" aria-hidden="true"><NavIcon name="server" size={16} /></span>
          <span className="rs-hint-t"><b>{hint.n}</b> unreachable resources point to the same host: <b className="mono">{hint.host}</b>. The issue is most likely on this server.</span>
          <button type="button" className="btn sm" onClick={() => { setQ(hint.host); setStatus("all"); }}>Show them →</button>
        </div>
      )}

      <div className="rs-tools">
        <label className="ma-search rs-search">
          <NavIcon name="search" size={16} />
          <input type="search" placeholder="Search name, address, connector or target…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search resources" />
          {q && <button type="button" className="rs-clear" aria-label="Clear search" onClick={() => setQ("")}>×</button>}
        </label>
        <div className="seg" role="group" aria-label="Status">
          {([["all", "All", counts.total], ["up", "Reachable", counts.up], ["down", "Unreachable", counts.down]] as const).map(([k, l, n]) => (
            <button key={k} type="button" className={status === k ? "seg-opt on" : "seg-opt"} aria-pressed={status === k} onClick={() => setStatus(k)}>{l} <span className="rs-n">{n}</span></button>
          ))}
        </div>
        <div className="seg" role="group" aria-label="Type">
          {([["all", "All"], ["web", "Web"], ["remote", "Remote"]] as const).map(([k, l]) => (
            <button key={k} type="button" className={kind === k ? "seg-opt on" : "seg-opt"} aria-pressed={kind === k} onClick={() => setKind(k)}>{l}</button>
          ))}
        </div>
        <div className="seg rs-view" role="group" aria-label="View">
          <button type="button" className={view === "cards" ? "seg-opt on" : "seg-opt"} aria-pressed={view === "cards"} onClick={() => choose("cards")} title="Cards" aria-label="Cards"><NavIcon name="grid" size={16} /></button>
          <button type="button" className={view === "list" ? "seg-opt on" : "seg-opt"} aria-pressed={view === "list"} onClick={() => choose("list")} title="List" aria-label="List"><NavIcon name="list" size={16} /></button>
        </div>
      </div>

      {shown.length === 0 ? (
        <div className="rs-none">
          <span>No resources match the filters.</span>
          <button type="button" className="btn sm" onClick={() => { setQ(""); setStatus("all"); setKind("all"); }}>Clear filters</button>
        </div>
      ) : view === "cards" ? (
        <div className="rs-grid">
          {shown.map((s) => <ResourceCard key={s.id} s={s} c={ctx} />)}
        </div>
      ) : (
        <div className="table-wrap rs-list">
          <div className="rs-lrow rs-lhead" aria-hidden="true"><span>Resource</span><span>Target</span><span>Connector</span><span>Status</span><span /></div>
          {shown.map((s) => <ResourceRow key={s.id} s={s} c={ctx} />)}
        </div>
      )}
      {toast && <div className={toast.ok ? "toast" : "toast warn"} role="status"><span aria-hidden="true">{toast.ok ? "✓" : "!"}</span> {toast.msg}</div>}
    </div>
  );
}

type Ctx = {
  health: (s: SiteRow) => Health;
  latency: (s: SiteRow) => number | null;
  checked: (s: SiteRow) => string | null;
  publicHost: (s: SiteRow) => string | null;
  testOne: (s: SiteRow) => Promise<void>;
  onDeleted: (name: string) => void;
};

function SumCell({ dot, label, value, unit, sub, on, onClick }: { dot: string; label: string; value: string; unit?: string; sub: string; on: boolean; onClick?: () => void }) {
  const inner = (
    <>
      <span className="kcell-k"><span className={`rs-kdot ${dot}`} aria-hidden="true" />{label}</span>
      <span className="kcell-row">
        <span className="kcell-v">{value}{unit && <small className="rs-unit"> {unit}</small>}</span>
        <span className="kcell-s">{sub}</span>
      </span>
    </>
  );
  return onClick ? (
    <button type="button" className={on ? `kcell rs-cell on ${dot}` : "kcell rs-cell"} role="listitem" aria-pressed={on} onClick={onClick}>{inner}</button>
  ) : (
    <div className="kcell rs-cell" role="listitem">{inner}</div>
  );
}

function Pill({ h, ms }: { h: Health; ms: number | null }) {
  if (h === "testing") return <span className="rs-pill testing"><span className="rs-spin" aria-hidden="true" /> Testing…</span>;
  if (h === "up") return <span className="rs-pill up"><span className="rs-pdot" aria-hidden="true" /> <span className="mono">{ms != null ? `${ms} ms` : "Reachable"}</span></span>;
  if (h === "down") return <span className="rs-pill down"><span className="rs-pdot" aria-hidden="true" /> Unreachable</span>;
  return <span className="rs-pill unknown">Not checked</span>;
}

function CopyIcon({ value, label }: { value: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className={done ? "rs-copy done" : "rs-copy"}
      aria-label={`Copy ${label}`}
      title={done ? "Copied" : `Copy ${label}`}
      onClick={async () => {
        try { await navigator.clipboard.writeText(value); setDone(true); setTimeout(() => setDone(false), 1400); } catch { /* ignore */ }
      }}
    >
      {done ? "✓" : (
        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" /></svg>
      )}
    </button>
  );
}

function Route({ s, h }: { s: SiteRow; h: Health }) {
  const t = target(s);
  return (
    <div className={`rs-route ${h}`}>
      <div className="rs-route-line" aria-hidden="true">
        <span className="rs-edge" />
        <span className="rs-seg solid" />
        <span className={s.connectorOnline ? "rs-conn" : "rs-conn off"}><NavIcon name="plug" size={13} /></span>
        <span className="rs-seg status">{h === "down" && <span className="rs-x">×</span>}</span>
        <span className="rs-target" />
      </div>
      <div className="rs-route-labels">
        <span><i>Edge</i><b>Captivo Edge</b></span>
        <span><i>Connector</i><b title={s.connectorName}>{s.connectorName}{!s.connectorOnline && <em className="t-bad"> · offline</em>}</b></span>
        <span className="rs-route-target">
          <i>Target</i>
          <b className="mono">{t ? <><span title={t}>{stripScheme(t)}</span><CopyIcon value={t} label="target" /></> : <span className="t-muted">none</span>}</b>
        </span>
      </div>
    </div>
  );
}

function Menu({ s, c }: { s: SiteRow; c: Ctx }) {
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) { setOpen(false); setConfirm(false); } };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { setOpen(false); setConfirm(false); } };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey); };
  }, [open]);
  async function del() {
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/sites/${encodeURIComponent(s.id)}`, { method: "DELETE" });
      const r = (await res.json().catch(() => ({}))) as { ok?: boolean };
      if (res.ok && r.ok) { setOpen(false); c.onDeleted(s.name); return; }
    } catch { /* fall through */ }
    setBusy(false);
    setConfirm(false);
  }
  return (
    <div className="rs-menu" ref={ref}>
      <button type="button" className="btn sm rs-more" aria-label={`More actions for ${s.name}`} aria-expanded={open} onClick={() => { setOpen((v) => !v); setConfirm(false); }}>⋯</button>
      {open && (
        <div className="rs-menu-pop">
          <Link href={`/admin/sites/${s.id}/edit`} className="rs-mi">Edit</Link>
          <Link href="/admin/grants?new=1" className="rs-mi">Grant access</Link>
          <hr />
          {confirm ? (
            <button type="button" className="rs-mi danger-solid" disabled={busy} onClick={del}>
              {busy ? "Deleting…" : s.grantCount > 0 ? `Sure? Delete (and ${s.grantCount} grant${s.grantCount === 1 ? "" : "s"})` : "Sure? Delete"}
            </button>
          ) : (
            <button type="button" className="rs-mi danger" onClick={() => setConfirm(true)}>Delete</button>
          )}
        </div>
      )}
    </div>
  );
}

function TestButton({ s, c, short }: { s: SiteRow; c: Ctx; short?: boolean }) {
  const testing = c.health(s) === "testing";
  return (
    <button type="button" className="btn sm rs-test" disabled={testing} onClick={() => void c.testOne(s)}>
      {testing ? <span className="rs-spin" aria-hidden="true" /> : <NavIcon name="activity" size={14} />} {testing ? "Testing…" : short ? "Test" : "Test connection"}
    </button>
  );
}

function ResourceCard({ s, c }: { s: SiteRow; c: Ctx }) {
  const h = c.health(s);
  const pub = c.publicHost(s);
  const proto = protocolOf(s);
  return (
    <article className="rs-card">
      <div className="rs-head">
        <span className={isRemote(s) ? "rs-proto remote" : "rs-proto"}>{proto}</span>
        <div className="rs-id">
          <div className="rs-name">
            <b title={s.name}>{s.name}</b>
            {s.accessMode === "GATEWAY" && <span className="rs-mode">GATEWAY</span>}
            {s.accessMode === "ISOLATED" && <span className="rs-mode">ISOLATED</span>}
          </div>
          <div className="rs-host">
            {pub ? <><span className="mono" title={pub}>{pub}</span><CopyIcon value={pub} label="address" /></> : <span className="t-muted">Only through Captivo</span>}
          </div>
        </div>
        <Pill h={h} ms={c.latency(s)} />
      </div>
      <Route s={s} h={h} />
      {h === "down" && s.probeDetail && <p className="rs-why">{s.probeDetail}</p>}
      <div className="rs-foot">
        <span className="rs-meta"><NavIcon name="users" size={14} /> {s.grantCount} user{s.grantCount === 1 ? "" : "s"}{c.checked(s) ? ` · ${c.checked(s)}` : ""}</span>
        <TestButton s={s} c={c} />
        <Menu s={s} c={c} />
      </div>
    </article>
  );
}

function ResourceRow({ s, c }: { s: SiteRow; c: Ctx }) {
  const h = c.health(s);
  const pub = c.publicHost(s);
  const t = target(s);
  return (
    <div className="rs-lrow">
      <span className="rs-lres">
        <span className={isRemote(s) ? "rs-proto sm remote" : "rs-proto sm"}>{protocolOf(s)}</span>
        <span className="rs-lres-t">
          <b title={s.name}>{s.name}</b>
          <span className="mono t-muted">{pub ?? "Only through Captivo"}</span>
        </span>
      </span>
      <span className="rs-ltarget mono">{t ? <><span title={t}>{stripScheme(t)}</span><CopyIcon value={t} label="target" /></> : <span className="t-muted">none</span>}</span>
      <span className="rs-lconn">
        <span>{s.connectorName}{!s.connectorOnline && <span className="t-bad"> · offline</span>}</span>
        <span className="t-muted">{s.grantCount} user{s.grantCount === 1 ? "" : "s"}{c.checked(s) ? ` · ${c.checked(s)}` : ""}</span>
      </span>
      <span><Pill h={h} ms={c.latency(s)} /></span>
      <span className="rs-lacts"><TestButton s={s} c={c} short /><Menu s={s} c={c} /></span>
    </div>
  );
}

function RefreshIcon({ spin }: { spin?: boolean }) {
  return (
    <svg className={spin ? "rs-rot" : undefined} viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 12a8 8 0 1 1-2.34-5.66" /><path d="M20 4v5h-5" />
    </svg>
  );
}
