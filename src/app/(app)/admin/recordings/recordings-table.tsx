"use client";

import { ResourceIcon } from "@/components/resource-icon";
import type { SiteTile } from "@/lib/access/grant-rows";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { NavIcon } from "@/app/(app)/_shell/nav-icons";
import { recordingType, type RecordingType } from "@/lib/recording/filter";
import type { RecordingKpis } from "@/lib/recording/kpis";
import { dayKey, dayLabel, hm, useZone } from "../audit/audit-zone";
import {
  Thumb, clockOf, copyRecordingLink, downloadRecording, downloadable, fileNameFor, humanBytes, initials,
  protocolLabel, requestErasure, spanOf,
} from "./rec-ui";

export interface RecordingRowJSON {
  id: string;
  startedAt: string;
  lastEventAt: string;
  /** Measured by the connector; null until it reports. */
  durationMs?: number | null;
  host: string;
  bytes: number;
  userId: string;
  userName: string | null;
  userEmail: string | null;
  siteId: string;
  siteName: string | null;
  /** The resource's tile; null when the resource was deleted. */
  site?: SiteTile | null;
  format: string;
  protocol: string | null;
  /** Capture stopped at the data plane's size cap while the session continued. */
  truncated: boolean;
  /** An erasure was asked for; the card stays until the connector confirms. */
  purgePending: boolean;
  videoReady: boolean;
}

type Opt = { id: string; name: string | null; email?: string | null };
type Filters = { q: string; cmd: string; userId: string; type: "" | RecordingType; empty: boolean };
type Hit = { atMs: number; text: string } | null;

const PAGE = 48;
const EMPTY_MS = 1000;
const lengthOf = (r: RecordingRowJSON) => r.durationMs ?? Math.max(0, Date.parse(r.lastEventAt) - Date.parse(r.startedAt));
const isEmpty = (r: RecordingRowJSON) => r.durationMs != null && r.durationMs < EMPTY_MS;

export function RecordingsTable({
  users, initialRows, initialTotal, kpis,
}: {
  users: Opt[];
  initialRows: RecordingRowJSON[];
  initialTotal: number;
  kpis: RecordingKpis;
}) {
  const zone = useZone();
  const router = useRouter();
  const [filters, setFilters] = useState<Filters>({ q: "", cmd: "", userId: "", type: "", empty: false });
  const [rows, setRows] = useState<RecordingRowJSON[]>(initialRows);
  const [total, setTotal] = useState(initialTotal);
  const [tooBroad, setTooBroad] = useState(false);
  const [partial, setPartial] = useState(false);
  const [unreachable, setUnreachable] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmBulk, setConfirmBulk] = useState(false);
  const [hits, setHits] = useState<Record<string, Hit>>({});
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sentinel = useRef<HTMLDivElement | null>(null);
  // Bumped on every load() call; a response is applied only if it's still the
  // most recently issued request, so a slow stale response can't clobber
  // newer rows (e.g. filter change while a page fetch is still in flight).
  const requestIdRef = useRef(0);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2600);
    return () => clearTimeout(t);
  }, [toast]);

  const load = useCallback(async (next: Filters, offset: number) => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    if (offset === 0) setFilters(next);
    try {
      const sp = new URLSearchParams();
      if (next.q.trim()) sp.set("q", next.q.trim());
      if (next.cmd.trim()) sp.set("cmd", next.cmd.trim());
      if (next.userId) sp.set("userId", next.userId);
      if (next.type) sp.set("type", next.type);
      if (next.empty) sp.set("empty", "1");
      sp.set("limit", String(PAGE));
      sp.set("offset", String(offset));
      const res = await fetch(`/api/admin/recordings?${sp.toString()}`);
      if (!res.ok) return;
      const body = (await res.json()) as {
        rows: RecordingRowJSON[];
        total: number;
        tooBroad?: boolean;
        partial?: boolean;
        unreachableConnectors?: string[];
      };
      if (requestId !== requestIdRef.current) return; // stale response, a newer request has since been issued
      setRows((prev) => (offset === 0 ? body.rows : [...prev, ...body.rows.filter((r) => !prev.some((p) => p.id === r.id))]));
      setTotal(body.total);
      setTooBroad(body.tooBroad ?? false);
      setPartial(body.partial ?? false);
      setUnreachable(body.unreachableConnectors ?? []);
      if (offset === 0) { setSelected(new Set()); setConfirmBulk(false); }
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, []);

  const set = <K extends keyof Filters>(k: K, v: Filters[K]) => load({ ...filters, [k]: v }, 0);
  function typed(k: "q" | "cmd", v: string) {
    setFilters((f) => ({ ...f, [k]: v }));
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => load({ ...filters, [k]: v }, 0), 350);
  }

  const more = rows.length < total;
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !more) return;
    const io = new IntersectionObserver((es) => { if (es[0]?.isIntersecting && !loading) load(filters, rows.length); }, { rootMargin: "500px" });
    io.observe(el);
    return () => io.disconnect();
  }, [more, loading, filters, rows.length, load]);

  // Where the command was typed in each matching recording: its keystroke
  // timeline, read from the connector one recording at a time.
  const cmd = filters.cmd.trim();
  useEffect(() => {
    if (cmd.length < 2) return;
    let stop = false;
    (async () => {
      for (const r of rows) {
        if (stop) return;
        if (hits[`${cmd}|${r.id}`] !== undefined) continue;
        const events = await fetch(`/api/admin/recordings/${r.id}/keyevents`).then((x) => (x.ok ? x.json() : [])).catch(() => []);
        const e = Array.isArray(events) ? (events as { atMs: number; text: string; masked: boolean }[]).find((x) => !x.masked && x.text.toLowerCase().includes(cmd.toLowerCase())) : undefined;
        if (stop) return;
        setHits((h) => ({ ...h, [`${cmd}|${r.id}`]: e ? { atMs: e.atMs, text: e.text } : null }));
      }
    })();
    return () => { stop = true; };
    // hits is read to skip work already done, not to re-run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cmd, rows]);

  function toggle(id: string) {
    setConfirmBulk(false);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  async function eraseSelected() {
    if (!confirmBulk) { setConfirmBulk(true); return; }
    const ids = [...selected];
    const n = await requestErasure(ids);
    setSelected(new Set());
    setConfirmBulk(false);
    setRows((prev) => prev.map((r) => (ids.includes(r.id) ? { ...r, purgePending: true } : r)));
    setToast({ msg: n === ids.length ? `Erasure requested for ${n} recording${n === 1 ? "" : "s"}. Applied when their connectors confirm.` : `Requested ${n} of ${ids.length}. Try the rest again.`, ok: n === ids.length });
  }

  const days = useMemo(() => {
    const out: { key: string; label: string; rows: RecordingRowJSON[] }[] = [];
    for (const r of rows) {
      const k = dayKey(r.startedAt, zone);
      const last = out[out.length - 1];
      if (last?.key === k) last.rows.push(r);
      else out.push({ key: k, label: dayLabel(r.startedAt, zone), rows: [r] });
    }
    return out;
  }, [rows, zone]);

  const filtered = !!(filters.q || filters.cmd || filters.userId || filters.type || filters.empty);
  const ctx: CardCtx = {
    zone, cmd, hits, selected, toggle,
    onToast: (msg, ok = true) => setToast({ msg, ok }),
    onErased: (id) => setRows((prev) => prev.map((r) => (r.id === id ? { ...r, purgePending: true } : r))),
    open: (id, atMs) => router.push(`/admin/recordings/${id}${atMs ? `?t=${Math.floor(atMs / 1000)}` : ""}`),
  };

  return (
    <section>
      <div className="kstrip rc-kpis">
        <div className="kcell">
          <span className="kcell-k"><span className="rs-kdot bad" />Recordings · 7 days</span>
          <span className="kcell-row"><span className="kcell-v">{kpis.week}</span><span className="kcell-s">on {kpis.weekSites} resource{kpis.weekSites === 1 ? "" : "s"}</span></span>
        </div>
        <div className="kcell">
          <span className="kcell-k"><span className="rs-kdot p" />Total length · 7 days</span>
          <span className="kcell-row rc-wrap"><span className="kcell-v rc-nowrap">{spanOf(kpis.weekMs)}</span><span className="kcell-s">to review</span></span>
        </div>
        <div className="kcell">
          <span className="kcell-k"><span className="rs-kdot violet" />Storage</span>
          <span className="kcell-row"><span className="kcell-v">{humanBytes(kpis.bytes)}</span><span className="kcell-s">on your connectors</span></span>
        </div>
        <button type="button" className={`kcell rs-cell warn${filters.empty ? " on" : ""}`} aria-pressed={filters.empty} onClick={() => set("empty", !filters.empty)}>
          <span className="kcell-k"><span className="rs-kdot warn" />Empty sessions</span>
          <span className="kcell-row"><span className="kcell-v">{kpis.empty}</span><span className="kcell-s">0 s · closed at once</span></span>
        </button>
      </div>

      <div className="rs-tools rc-tools">
        <label className="ma-search rc-search">
          <NavIcon name="search" size={16} />
          <input type="search" placeholder="Resource, host or user" value={filters.q} onChange={(e) => typed("q", e.target.value)} aria-label="Search recordings" />
        </label>
        <label className={filters.cmd ? "ma-search rc-cmd on" : "ma-search rc-cmd"}>
          <span className="rc-prompt" aria-hidden="true">&gt;_</span>
          <input type="search" placeholder="Search commands: rm -rf, systemctl…" value={filters.cmd} onChange={(e) => typed("cmd", e.target.value)} aria-label="Search typed commands" />
        </label>
        <div className="seg" role="group" aria-label="Type">
          {([["", "All", kpis.byType.all], ["web", "Web", kpis.byType.web], ["rdp", "RDP", kpis.byType.rdp], ["ssh", "SSH", kpis.byType.ssh], ...(kpis.byType.sql ? [["sql", "Database", kpis.byType.sql]] as const : [])] as const).map(([k, l, n]) => (
            <button key={k} type="button" className={filters.type === k ? "seg-opt on" : "seg-opt"} aria-pressed={filters.type === k} onClick={() => set("type", k)}>{l} <span className="rs-n">{n}</span></button>
          ))}
        </div>
        <span className="au-sel rc-user">
          <select value={filters.userId} onChange={(e) => set("userId", e.target.value)} aria-label="User">
            <option value="">All users</option>
            {users.map((u) => <option key={u.id} value={u.id}>{u.name ?? u.email}</option>)}
          </select>
        </span>
      </div>

      {partial ? (
        <p className="notice warn" role="status">
          This answer is incomplete: {unreachable.length || "some"} connector{unreachable.length === 1 ? " was" : "s were"} offline and could not be searched.
          Typed commands are stored on their connector, so recordings there may match but are not shown.
        </p>
      ) : null}
      {tooBroad ? <p className="notice warn" role="status">Too many recordings to search at once. Pick a user or type to narrow it.</p> : null}

      {rows.length === 0 ? (
        <div className="au-empty">
          <span className="au-empty-ic"><NavIcon name="video" size={18} /></span>
          <b>{loading ? "Loading…" : filtered ? "No recordings match these filters" : "No recordings yet"}</b>
          {!loading && <span className="cell-sub">{filtered ? "Clear a filter or try another search." : "Sessions on resources with recording on appear here."}</span>}
          {!loading && filtered && <button type="button" className="btn sm" onClick={() => load({ q: "", cmd: "", userId: "", type: "", empty: false }, 0)}>Clear filters</button>}
        </div>
      ) : (
        days.map((d) => (
          <div key={d.key + d.rows[0].id} className="rc-day">
            <div className="rc-dayhead"><span>{d.label}</span><i /><span>{d.rows.length} recording{d.rows.length === 1 ? "" : "s"}</span></div>
            <div className="rc-grid">{d.rows.map((r) => <Card key={r.id} r={r} c={ctx} />)}</div>
          </div>
        ))
      )}
      <div ref={sentinel} className="au-end cell-sub">
        {rows.length > 0 && (more ? (loading ? "Loading older recordings…" : "Scroll for older recordings") : `All ${total} recording${total === 1 ? "" : "s"} shown`)}
      </div>

      {selected.size > 0 && (
        <div className="rc-bulk" role="region" aria-label="Selected recordings">
          <b>{selected.size} recording{selected.size === 1 ? "" : "s"} selected</b>
          <button type="button" className={confirmBulk ? "rc-bbtn danger on" : "rc-bbtn danger"} onClick={eraseSelected}>
            {confirmBulk ? `Request erasure of ${selected.size}?` : "Request erasure"}
          </button>
          <button type="button" className="rc-bx" aria-label="Clear selection" onClick={() => { setSelected(new Set()); setConfirmBulk(false); }}>×</button>
        </div>
      )}
      {toast && <div className={toast.ok ? "toast" : "toast warn"} role="status"><span aria-hidden="true">{toast.ok ? "✓" : "!"}</span> {toast.msg}</div>}
    </section>
  );
}

type CardCtx = {
  zone: string;
  cmd: string;
  hits: Record<string, Hit>;
  selected: Set<string>;
  toggle: (id: string) => void;
  onToast: (msg: string, ok?: boolean) => void;
  onErased: (id: string) => void;
  open: (id: string, atMs?: number) => void;
};

function Card({ r, c }: { r: RecordingRowJSON; c: CardCtx }) {
  const kind = recordingType(r);
  const empty = isEmpty(r);
  const len = lengthOf(r);
  const sel = c.selected.has(r.id);
  const hit = c.cmd.length >= 2 ? c.hits[`${c.cmd}|${r.id}`] : undefined;
  const name = r.userName ?? r.userEmail ?? "Unknown user";
  const blocked = empty || r.purgePending;
  return (
    <article className={`rc-card${sel ? " sel" : ""}${blocked ? " dim" : ""}`}>
      <div className="rc-thumb">
        <Thumb kind={kind} />
        <span className="rc-badge">{protocolLabel(r)}</span>
        {!blocked && <span className="rc-len mono">{clockOf(len)}</span>}
        {r.truncated ? <span className="rc-cut">cut short</span> : null}
        {r.purgePending ? (
          <span className="rc-scrim"><b>Erasure pending</b><span>Removed when its connector confirms</span></span>
        ) : empty ? (
          <span className="rc-scrim"><b>Empty session</b><span>The connection closed at once</span></span>
        ) : (
          <Link href={`/admin/recordings/${r.id}`} className="rc-playbtn" aria-label={`Play ${r.siteName ?? r.host}, ${clockOf(len)}`}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13l11-6.5z" /></svg>
          </Link>
        )}
        {!r.purgePending && (
          <input type="checkbox" className="rc-check" checked={sel} onChange={() => c.toggle(r.id)} aria-label={`Select ${r.siteName ?? r.host} at ${hm(r.startedAt, c.zone)}`} />
        )}
      </div>
      <div className="rc-info">
        <div className="rc-line">
          {r.site && <ResourceIcon name={r.site.icon} color={r.site.color} logoUrl={r.site.logoUrl} logoBg={r.site.logoBg} size={22} className="rc-site-ic" />}
          <b className="rc-name" title={r.host}>{r.siteName ?? r.host}</b>
          <span className="mono rc-time">{hm(r.startedAt, c.zone)}</span>
          {!r.purgePending && <CardMenu r={r} c={c} />}
        </div>
        <div className="rc-line sub">
          <span className="rc-user"><span className="au-av sm" aria-hidden="true">{initials(name)}</span><span>{name}</span></span>
          <span className="mono rc-size">{humanBytes(r.bytes)}</span>
        </div>
        {hit ? (
          <button type="button" className="rc-hit" onClick={() => c.open(r.id, hit.atMs)} title="Open the recording at this moment">
            <span className="mono">{clockOf(hit.atMs)}</span><span className="mono rc-hit-t">$ {hit.text}</span>
          </button>
        ) : c.cmd.length >= 2 && hit === undefined ? <span className="rc-hit wait mono">finding the command…</span> : null}
      </div>
    </article>
  );
}

function CardMenu({ r, c }: { r: RecordingRowJSON; c: CardCtx }) {
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) { setOpen(false); setConfirm(false); } };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { setOpen(false); setConfirm(false); } };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey); };
  }, [open]);

  async function download() {
    setBusy("Preparing…");
    const ok = await downloadRecording(r.id, fileNameFor(r.siteName ?? r.host, r.startedAt), (p) => setBusy(`Downloading ${p}%`));
    setBusy(null);
    setOpen(false);
    c.onToast(ok ? "Download saved" : "The download did not finish. Its connector may be offline.", ok);
  }
  async function erase() {
    if (!confirm) { setConfirm(true); return; }
    setBusy("Requesting…");
    const n = await requestErasure([r.id]);
    setBusy(null);
    setOpen(false);
    setConfirm(false);
    if (n) c.onErased(r.id);
    c.onToast(n ? "Erasure requested. Applied when its connector confirms." : "Couldn't request the erasure. Try again.", n > 0);
  }

  return (
    <div className="rs-menu" ref={ref}>
      <button type="button" className="btn sm rs-more" aria-label={`More actions for ${r.siteName ?? r.host}`} aria-expanded={open} onClick={() => { setOpen((v) => !v); setConfirm(false); }}>⋯</button>
      {open && (
        <div className="rs-menu-pop rc-pop">
          {downloadable(r) && <button type="button" className="rs-mi" disabled={!!busy} onClick={download}>{busy?.startsWith("Download") || busy === "Preparing…" ? busy : "Download video"}</button>}
          <button type="button" className="rs-mi" onClick={async () => { const ok = await copyRecordingLink(r.id); setOpen(false); c.onToast(ok ? "Link copied. It opens for signed-in admins." : "Couldn't copy the link", ok); }}>Copy link</button>
          <hr />
          <button type="button" className={confirm ? "rs-mi danger-solid" : "rs-mi danger"} disabled={busy === "Requesting…"} onClick={erase}>
            {busy === "Requesting…" ? busy : confirm ? "Sure? Request erasure" : "Request erasure"}
          </button>
        </div>
      )}
    </div>
  );
}
