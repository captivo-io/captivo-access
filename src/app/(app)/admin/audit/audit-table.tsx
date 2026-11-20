"use client";

import { ResourceIcon } from "@/components/resource-icon";
import type { SiteTile } from "@/lib/access/grant-rows";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { usePathname, useRouter } from "next/navigation";
import { NavIcon } from "@/app/(app)/_shell/nav-icons";
import { parseDatetimeLocal, formatDatetimeLocal } from "@/lib/time/datetime-local";
import { accessReasonLabel, isNativeRdpMethod, transferBadge } from "@/lib/audit/access-format";
import { groupBursts, describeAgent, type Burst } from "@/lib/audit/grouping";
import type { Histogram } from "@/lib/audit/histogram";
import { AuditDrawer, DetailList } from "./audit-drawer";
import { RANGES, resolveRange, type RangeKey } from "./range";
import { clock, dayKey, dayLabel, fmt, hm, isoWithOffset, useZone } from "./audit-zone";

export type AccessRowJSON = {
  id: string;
  timestamp: string;
  userId: string | null;
  userEmail: string | null;
  userName: string | null;
  company: string | null;
  siteId: string | null;
  siteName: string | null;
  host: string;
  method: string;
  path: string;
  status: number;
  bytesOut: string;
  decision: "ALLOW" | "DENY";
  reason: string | null;
  clientIp: string | null;
  userAgent: string | null;
  seq: string;
  prevHash: string;
  hash: string;
};

export type AccessFilters = {
  q: string;
  userId: string;
  siteId: string;
  decision: "" | "ALLOW" | "DENY";
  kind: "" | "file";
  range: RangeKey;
  /** ISO, custom range only. */
  from: string;
  to: string;
};

export interface UserInfo { id: string; name: string; email: string; company: string | null; vendor: boolean }
/** A resource as its tile shows it (lib/access/grant-rows siteTile). */
export type SiteInfo = SiteTile;

const PAGE = 100;

export function formatBytes(raw: string): string {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const v = n / 1024 ** i;
  return `${i === 0 ? v : v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

const initials = (s: string) => (s.split(/[\s@.]+/).filter(Boolean).map((w) => w[0]).slice(0, 2).join("") || "?").toUpperCase();
// A remote session's open / close marker (the reason carries which), not an HTTP request.
const isSession = (r: AccessRowJSON) => /^session_(open|close)/.test(r.reason ?? "");
const notHttp = (r: AccessRowJSON) => r.method === "CONNECT" || isSession(r) || isNativeRdpMethod(r.method);

function params(f: AccessFilters, offset: number, histogram: boolean): URLSearchParams {
  const p = new URLSearchParams();
  if (f.q) p.set("q", f.q);
  if (f.userId) p.set("userId", f.userId);
  if (f.siteId) p.set("siteId", f.siteId);
  if (f.decision) p.set("decision", f.decision);
  if (f.kind) p.set("kind", f.kind);
  const { from, to } = resolveRange(f.range, f.from, f.to, new Date());
  p.set("from", from.toISOString());
  p.set("to", to.toISOString());
  p.set("limit", String(PAGE));
  p.set("offset", String(offset));
  if (histogram) p.set("histogram", "1");
  return p;
}

// What the address bar keeps: the filters as chosen, not resolved instants.
function pageQuery(f: AccessFilters): string {
  const p = new URLSearchParams();
  if (f.q) p.set("q", f.q);
  if (f.userId) p.set("userId", f.userId);
  if (f.siteId) p.set("siteId", f.siteId);
  if (f.decision) p.set("decision", f.decision);
  if (f.kind) p.set("kind", f.kind);
  if (f.range !== "24h") p.set("range", f.range);
  if (f.range === "custom") { if (f.from) p.set("from", f.from); if (f.to) p.set("to", f.to); }
  return p.toString();
}

/** The method chip: the session protocol for a remote connect, a transfer direction, or the HTTP verb. */
function Method({ r, site }: { r: AccessRowJSON; site?: SiteInfo }) {
  const t = transferBadge(r.method);
  if (t.isTransfer) return <span className="au-m file">{t.direction === "download" ? "↓ FILE" : "↑ FILE"}</span>;
  if (r.method === "CONNECT") return <span className="au-m">{site?.remote ? site.proto : "WS"}</span>;
  if (isNativeRdpMethod(r.method)) return <span className="au-m" title={r.method}>RDP</span>;
  const cls = { GET: "get", HEAD: "get", POST: "post", PUT: "put", PATCH: "put", DELETE: "del" }[r.method] ?? "";
  return <span className={`au-m ${cls}`}>{r.method}</span>;
}

function pathText(r: AccessRowJSON): string {
  if (isSession(r)) return (accessReasonLabel(r.reason) ?? "connect").replace(/^Session /, "session ");
  if (r.method === "CONNECT") return "connect";
  const t = transferBadge(r.method);
  return t.isTransfer ? `${t.partial ? "partial " : ""}${t.direction}: ${r.path}` : r.path;
}

function Status({ r }: { r: AccessRowJSON }) {
  if (notHttp(r) || r.status === 101) return <span className="au-st muted">—</span>;
  const s = r.status;
  const cls = s >= 500 ? "bad" : s >= 400 ? "warn" : s >= 300 ? "muted" : "";
  return <span className={`au-st ${cls}`}>{s}</span>;
}

const Decision = ({ d }: { d: "ALLOW" | "DENY" }) =>
  d === "ALLOW" ? <span className="au-dec ok">Allow</span> : <span className="au-dec bad">Deny</span>;

export function AccessLog({
  users, sites, initialRows, initialTotal, initialHistogram, initialFilters,
}: {
  users: UserInfo[];
  sites: SiteInfo[];
  initialRows: AccessRowJSON[];
  initialTotal: number;
  initialHistogram: Histogram;
  initialFilters: AccessFilters;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const zone = useZone();
  const [filters, setFilters] = useState<AccessFilters>(initialFilters);
  const [rows, setRows] = useState(initialRows);
  const [total, setTotal] = useState(initialTotal);
  const [hist, setHist] = useState(initialHistogram);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<AccessRowJSON | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(initialRows[0] ? [initialRows[0].id] : []));
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const seq = useRef(0);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sentinel = useRef<HTMLDivElement | null>(null);

  useEffect(() => setSlot(document.getElementById("au-head-actions")), []);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2600);
    return () => clearTimeout(t);
  }, [toast]);

  const siteById = useMemo(() => new Map(sites.map((s) => [s.id, s])), [sites]);
  const userById = useMemo(() => new Map(users.map((u) => [u.id, u])), [users]);
  const bursts = useMemo(() => groupBursts(rows), [rows]);

  const load = useCallback(async (next: AccessFilters, offset: number) => {
    const mine = ++seq.current;
    setBusy(true);
    setError(null);
    if (offset === 0) setFilters(next);
    try {
      const res = await fetch(`/api/admin/audit?${params(next, offset, offset === 0)}`);
      const body = await res.json().catch(() => ({}));
      if (mine !== seq.current) return;
      if (!res.ok || !Array.isArray(body?.rows)) { setError("Couldn't load audit events, please try again."); return; }
      if (offset === 0) {
        setRows(body.rows);
        setExpanded(new Set(body.rows[0] ? [body.rows[0].id] : []));
        if (body.histogram) setHist(body.histogram);
        const q = pageQuery(next);
        router.replace(q ? `${pathname}?${q}` : pathname, { scroll: false });
      } else {
        setRows((prev) => [...prev, ...body.rows.filter((r: AccessRowJSON) => !prev.some((p) => p.id === r.id))]);
      }
      setTotal(typeof body.total === "number" ? body.total : 0);
    } catch {
      if (mine === seq.current) setError("Couldn't load audit events, please try again.");
    } finally {
      if (mine === seq.current) setBusy(false);
    }
  }, [pathname, router]);

  const set = <K extends keyof AccessFilters>(k: K, v: AccessFilters[K]) => load({ ...filters, [k]: v }, 0);

  function search(q: string) {
    setFilters((f) => ({ ...f, q }));
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => load({ ...filters, q }, 0), 300);
  }

  const more = rows.length < total;
  // Older records load as the end of the list scrolls into view.
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !more) return;
    const io = new IntersectionObserver((es) => { if (es[0]?.isIntersecting && !busy) load(filters, rows.length); }, { rootMargin: "400px" });
    io.observe(el);
    return () => io.disconnect();
  }, [more, busy, filters, rows.length, load]);

  const exportHref = `/api/admin/audit/export?${params(filters, 0, false)}`;
  const filtered = !!(filters.q || filters.userId || filters.siteId || filters.decision || filters.kind);

  function toggle(id: string) {
    setExpanded((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  }

  // Bursts under day headers.
  const days: { key: string; label: string; bursts: Burst<AccessRowJSON>[] }[] = [];
  for (const b of bursts) {
    const k = dayKey(b.end, zone);
    const last = days[days.length - 1];
    if (last?.key === k) last.bursts.push(b);
    else days.push({ key: k, label: dayLabel(b.end, zone), bursts: [b] });
  }

  return (
    <div>
      {slot && createPortal(<a href={exportHref} className="btn"><NavIcon name="download" size={16} /> Export CSV</a>, slot)}

      <section className="au-filters">
        <div className="au-frow">
          <label className="ma-search au-search">
            <NavIcon name="search" size={16} />
            <input type="search" placeholder="Search path, host, user or IP…" value={filters.q} onChange={(e) => search(e.target.value)} aria-label="Search" />
            {filters.q && <button type="button" className="rs-clear" aria-label="Clear search" onClick={() => load({ ...filters, q: "" }, 0)}>×</button>}
          </label>
          <span className="au-sel">
            <select value={filters.userId} onChange={(e) => set("userId", e.target.value)} aria-label="User">
              <option value="">All users</option>
              {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          </span>
          <span className="au-sel">
            <select value={filters.siteId} onChange={(e) => set("siteId", e.target.value)} aria-label="Resource">
              <option value="">All resources</option>
              {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </span>
          <div className="seg au-dseg" role="group" aria-label="Decision">
            {([["", "All", ""], ["ALLOW", "Allow", "ok"], ["DENY", "Deny", "bad"]] as const).map(([k, l, dot]) => (
              <button key={k} type="button" className={filters.decision === k ? "seg-opt on" : "seg-opt"} aria-pressed={filters.decision === k} onClick={() => set("decision", k)}>
                {dot && <span className={`rs-kdot ${dot}`} aria-hidden="true" />}{l}
              </button>
            ))}
          </div>
          <button type="button" className={filters.kind === "file" ? "au-chip on" : "au-chip"} aria-pressed={filters.kind === "file"} onClick={() => set("kind", filters.kind === "file" ? "" : "file")}>
            <NavIcon name="folder" size={15} /> File transfers only
          </button>
        </div>
        <div className="au-frow au-frow2">
          <div className="au-range">
            <span className="kcell-k">Time range · {zone}</span>
            <div className="au-pills">
              {RANGES.map((r) => (
                <button key={r.key} type="button" className={filters.range === r.key ? "au-pill on" : "au-pill"} aria-pressed={filters.range === r.key}
                  onClick={() => {
                    if (r.key !== "custom") return set("range", r.key);
                    const { from, to } = resolveRange(filters.range, filters.from, filters.to, new Date());
                    load({ ...filters, range: "custom", from: from.toISOString(), to: to.toISOString() }, 0);
                  }}>{r.label}</button>
              ))}
            </div>
            {filters.range === "custom" && (
              <div className="au-custom">
                <input type="datetime-local" className="input" aria-label="From" value={filters.from ? formatDatetimeLocal(new Date(filters.from), zone) : ""}
                  onChange={(e) => { const d = parseDatetimeLocal(e.target.value, zone); if (d) set("from", d.toISOString()); }} />
                <span className="cell-sub">to</span>
                <input type="datetime-local" className="input" aria-label="To" value={filters.to ? formatDatetimeLocal(new Date(filters.to), zone) : ""}
                  onChange={(e) => { const d = parseDatetimeLocal(e.target.value, zone); if (d) set("to", d.toISOString()); }} />
              </div>
            )}
          </div>
          <Chart hist={hist} zone={zone} />
        </div>
      </section>

      {error && <p className="notice error" role="alert">{error}</p>}

      <div className="au-meta">
        <span><b>{rows.length.toLocaleString("en-US")} event{rows.length === 1 ? "" : "s"} shown</b> · grouped into {bursts.length} session{bursts.length === 1 ? "" : "s"}</span>
        {bursts.length > 0 && (
          <span className="au-meta-act">
            <button type="button" onClick={() => setExpanded(new Set(bursts.map((b) => b.id)))}>Expand all</button>
            <span aria-hidden="true">·</span>
            <button type="button" onClick={() => setExpanded(new Set())}>Collapse all</button>
          </span>
        )}
      </div>

      {rows.length === 0 ? (
        <div className="au-empty">
          <span className="au-empty-ic"><NavIcon name="list" size={18} /></span>
          <b>{busy ? "Loading…" : filtered ? "No events match these filters" : "No events in this time range"}</b>
          {!busy && <span className="cell-sub">{filtered ? "Clear a filter or widen the time range." : "Every request through a connector lands here. Try a longer range."}</span>}
          {!busy && (filtered
            ? <button type="button" className="btn sm" onClick={() => load({ ...filters, q: "", userId: "", siteId: "", decision: "", kind: "" }, 0)}>Clear filters</button>
            : filters.range !== "7d" && <button type="button" className="btn sm" onClick={() => set("range", "7d")}>Show the last 7 days</button>)}
        </div>
      ) : (
        <div className={busy && !more ? "au-log busy" : "au-log"}>
          {days.map((d) => (
            <div key={d.key + d.bursts[0].id}>
              <div className="au-day">{d.label}</div>
              {d.bursts.map((b) => (
                <BurstView key={b.id} b={b} zone={zone} site={b.rows[0].siteId ? siteById.get(b.rows[0].siteId) : undefined}
                  user={b.rows[0].userId ? userById.get(b.rows[0].userId) : undefined}
                  open={expanded.has(b.id)} onToggle={() => toggle(b.id)} selected={open?.id} onPick={setOpen} siteById={siteById} />
              ))}
            </div>
          ))}
        </div>
      )}
      <div ref={sentinel} className="au-end cell-sub">
        {rows.length > 0 && (more
          ? <>{busy ? "Loading older records…" : "Scroll for older records"} · first {rows.length.toLocaleString("en-US")} of {total.toLocaleString("en-US")} events</>
          : <>All {total.toLocaleString("en-US")} events in this range shown</>)}
      </div>

      {open && (
        <EventDrawer r={open} zone={zone} site={open.siteId ? siteById.get(open.siteId) : undefined} onClose={() => setOpen(null)}
          onCopy={async () => { try { await navigator.clipboard.writeText(open.path); setToast("Path copied"); } catch { setToast("Couldn't copy"); } }}
          onUser={open.userId ? () => { setOpen(null); set("userId", open.userId!); } : undefined}
          onIp={open.clientIp ? () => { setOpen(null); load({ ...filters, q: open.clientIp! }, 0); } : undefined} />
      )}
      {toast && <div className="toast" role="status"><span aria-hidden="true">✓</span> {toast}</div>}
    </div>
  );
}

function BurstView({ b, zone, site, user, open, onToggle, selected, onPick, siteById }: {
  b: Burst<AccessRowJSON>; zone: string; site?: SiteInfo; user?: UserInfo; open: boolean; onToggle: () => void;
  selected?: string; onPick: (r: AccessRowJSON) => void; siteById: Map<string, SiteInfo>;
}) {
  const r0 = b.rows[0];
  const name = r0.userName ?? user?.name ?? r0.userEmail ?? "Anonymous";
  const vendor = user?.vendor ?? false;
  const company = r0.company ?? user?.company ?? (r0.userId ? (vendor ? "Vendor" : "Internal") : "Not signed in");
  const agent = describeAgent(b.rows.find((r) => r.userAgent)?.userAgent);
  const n = b.rows.length;
  return (
    <div className={open ? "au-burst open" : "au-burst"}>
      <button type="button" className="au-bhead" aria-expanded={open} onClick={onToggle}>
        <span className="au-chev" aria-hidden="true">▸</span>
        <span className="au-who">
          <span className={vendor ? "au-av vendor" : r0.userId ? "au-av" : "au-av anon"} aria-hidden="true">{initials(name)}</span>
          <span className="au-stack"><b>{name}</b><span className="cell-sub">{company}</span></span>
        </span>
        <span className="au-res">
          {site ? <ResourceIcon name={site.icon} color={site.color} logoUrl={site.logoUrl} logoBg={site.logoBg} size={30} /> : <ResourceIcon name="globe" color="slate" size={30} />}
          <span className="au-stack"><b>{r0.siteName ?? site?.name ?? r0.host}</b><span className="mono cell-sub"><span className="rs-proto-l">{site?.proto ?? "WEB"}</span> · {r0.host}</span></span>
        </span>
        <span className="au-stack au-ip"><span className="mono">{r0.clientIp ?? "—"}</span>{agent && <span className="cell-sub">{agent}</span>}</span>
        <span className="au-bpills">
          <span className="au-bp">{n} request{n === 1 ? "" : "s"}</span>
          {b.denied > 0 && <span className="au-bp bad">{b.denied} denied</span>}
          {b.files > 0 && <span className="au-bp file">{b.files} file{b.files === 1 ? "" : "s"}</span>}
          <span className="mono au-span">{hm(b.start, zone) === hm(b.end, zone) ? hm(b.end, zone) : `${hm(b.start, zone)}–${hm(b.end, zone)}`}</span>
        </span>
      </button>
      {open && (
        <div className="au-events">
          {b.rows.map((r) => {
            const s = r.siteId ? siteById.get(r.siteId) : site;
            const why = r.decision === "DENY" ? accessReasonLabel(r.reason) : null;
            const t = transferBadge(r.method);
            return (
              <div key={r.id} role="button" tabIndex={0} className={`au-ev${r.decision === "DENY" ? " deny" : ""}${selected === r.id ? " sel" : ""}`}
                onClick={() => onPick(r)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onPick(r); } }}>
                <span className="mono au-t">{clock(r.timestamp, zone)}</span>
                <span><Method r={r} site={s} /></span>
                <span className="au-p">
                  <span className="mono au-path" title={r.path}>{pathText(r)}</span>
                  {why && <span className="au-why-l">{why}</span>}
                </span>
                <Status r={r} />
                <span><Decision d={r.decision} /></span>
                <span className="mono au-sz">{t.isTransfer || Number(r.bytesOut) > 0 ? formatBytes(r.bytesOut) : ""}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Chart({ hist, zone }: { hist: Histogram; zone: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...hist.allow.map((a, i) => a + hist.deny[i]));
  const allow = hist.allow.reduce((a, b) => a + b, 0);
  const deny = hist.deny.reduce((a, b) => a + b, 0);
  const start = Date.parse(hist.start);
  const n = hist.allow.length;
  const at = (i: number) => start + i * hist.widthMs;
  const long = hist.widthMs >= 6 * 3_600_000;
  const label = (i: number) => (long ? fmt(at(i), zone, { month: "short", day: "numeric" }) : hm(at(i), zone));
  const ticks = [0, Math.round(n / 4), Math.round(n / 2), Math.round((3 * n) / 4)];
  return (
    <div className="au-chart">
      <div className="au-legend">
        <span><i className="ok" />Allow <b>{allow.toLocaleString("en-US")}</b></span>
        <span><i className="bad" />Deny <b>{deny.toLocaleString("en-US")}</b></span>
      </div>
      <div className="au-bars" onMouseLeave={() => setHover(null)}>
        {hist.allow.map((a, i) => {
          const d = hist.deny[i];
          return (
            <span key={i} className="au-bar" onMouseEnter={() => setHover(i)} aria-label={`${label(i)}: ${a} allowed, ${d} denied`}>
              <span className="d" style={{ height: `${(d / max) * 100}%` }} />
              <span className="a" style={{ height: `${(a / max) * 100}%` }} />
            </span>
          );
        })}
        {hover !== null && (
          <span className="au-tip" style={{ left: `${((hover + 0.5) / n) * 100}%` }}>
            <b>{label(hover)}–{long ? label(hover + 1) : hm(at(hover + 1), zone)}</b>
            <span>{hist.allow[hover]} allowed · {hist.deny[hover]} denied</span>
          </span>
        )}
      </div>
      <div className="au-axis mono">
        {ticks.map((t) => <span key={t} style={{ left: `${(t / n) * 100}%` }}>{label(t)}</span>)}
        <span className="now">NOW</span>
      </div>
    </div>
  );
}

function EventDrawer({ r, zone, site, onClose, onCopy, onUser, onIp }: {
  r: AccessRowJSON; zone: string; site?: SiteInfo; onClose: () => void; onCopy: () => void; onUser?: () => void; onIp?: () => void;
}) {
  const why = accessReasonLabel(r.reason);
  const short = (h: string) => (h ? `${h.slice(0, 10)}…` : "genesis");
  return (
    <AuditDrawer title={`Event detail · seq #${r.seq}`} onClose={onClose}
      footer={<>
        <button type="button" className="btn sm" onClick={onCopy}><CopyIcon /> Copy path</button>
        {onUser && <button type="button" className="btn sm" onClick={onUser}>Filter this user</button>}
        {onIp && <button type="button" className="btn sm" onClick={onIp}>Filter this IP</button>}
      </>}>
      <div className="au-dpath"><Method r={r} site={site} /><span className="mono">{pathText(r)}</span></div>
      <div className={r.decision === "ALLOW" ? "au-dbox ok" : "au-dbox bad"}>
        <b>{r.decision === "ALLOW" ? "Allowed" : "Denied"}</b>
        {why && <span>{r.decision === "ALLOW" ? `Matched: ${why}` : why}</span>}
      </div>
      <DetailList items={[
        ["Time", <span key="t" className="mono">{isoWithOffset(r.timestamp, zone)}</span>],
        ["User", r.userName ? <>{r.userName}{r.userEmail && <div className="cell-sub">{r.userEmail}</div>}</> : (r.userEmail ?? "Not signed in")],
        ["Company", r.company ?? "—"],
        ["Resource", r.siteName ?? "—"],
        ["Host", <span key="h" className="mono">{r.host}</span>],
        ["Status code", notHttp(r) ? "—" : <span key="s" className="mono">{r.status}</span>],
        ["Size", formatBytes(r.bytesOut)],
        ["IP", <span key="ip"><span className="mono">{r.clientIp ?? "—"}</span>{describeAgent(r.userAgent) && <div className="cell-sub">{describeAgent(r.userAgent)}</div>}</span>],
        ["User agent", <span key="ua" className="au-ua">{r.userAgent || "—"}</span>],
      ]} />
      <div className="au-dchain">
        <b><NavIcon name="shield" size={14} /> Chained record</b>
        <div className="au-hashes mono">
          <span title={r.prevHash || "genesis"}>#{Number(r.seq) - 1 || "0"} {short(r.prevHash)}</span>
          <span aria-hidden="true">→</span>
          <span className="cur" title={r.hash}>#{r.seq} {short(r.hash)}</span>
        </div>
        <span className="cell-sub">Each record carries the hash of the one before it. &quot;Verify again&quot; above checks the whole chain.</span>
      </div>
    </AuditDrawer>
  );
}

function CopyIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" />
    </svg>
  );
}
