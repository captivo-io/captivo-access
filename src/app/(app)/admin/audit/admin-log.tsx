"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { NavIcon } from "@/app/(app)/_shell/nav-icons";
import { adminActionLabel, adminCategory, adminMergedSummary, type AdminCategory } from "@/lib/audit/admin-actions";
import { mergeAdminRows } from "@/lib/audit/grouping";
import { AuditDrawer, DetailList } from "./audit-drawer";
import { dayKey, dayLabel, hm, isoWithOffset, useZone } from "./audit-zone";

export interface AdminRowJSON {
  id: string;
  seq: string | null;
  timestamp: string;
  actorEmail: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  summary: string;
  clientIp: string | null;
  prevHash: string;
  hash: string;
}

const PAGE = 100;

const CATEGORIES: { key: AdminCategory | ""; label: string; dot?: string; icon?: Parameters<typeof NavIcon>[0]["name"] }[] = [
  { key: "", label: "All" },
  { key: "connector", label: "Connector", dot: "ok", icon: "plug" },
  { key: "recording", label: "Recording", dot: "bad", icon: "video" },
  { key: "access", label: "Access", dot: "violet", icon: "key" },
  { key: "resource", label: "Resource", dot: "p", icon: "server" },
  { key: "identity", label: "Identity", dot: "muted", icon: "lock" },
  { key: "settings", label: "Settings", dot: "warn", icon: "settings" },
];
const CAT = Object.fromEntries(CATEGORIES.filter((c) => c.key).map((c) => [c.key, c])) as Record<AdminCategory, (typeof CATEGORIES)[number]>;

const initials = (s: string) => (s.split(/[\s@.]+/).filter(Boolean).map((w) => w[0]).slice(0, 2).join("") || "?").toUpperCase();

const mergedText = (g: AdminRowJSON[]) => adminMergedSummary(g[0].action, g.length, g[0].summary);

export function AdminLog({ initialRows, initialTotal }: { initialRows: AdminRowJSON[]; initialTotal: number }) {
  const zone = useZone();
  const [q, setQ] = useState("");
  const [cat, setCat] = useState<AdminCategory | "">("");
  const [rows, setRows] = useState(initialRows);
  const [total, setTotal] = useState(initialTotal);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<AdminRowJSON[] | null>(null);
  const [shown, setShown] = useState<Set<string>>(new Set());
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const seq = useRef(0);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sentinel = useRef<HTMLDivElement | null>(null);

  useEffect(() => setSlot(document.getElementById("au-head-actions")), []);

  const query = (nq: string, nc: string, offset: number) => {
    const p = new URLSearchParams();
    if (nq.trim()) p.set("q", nq.trim());
    if (nc) p.set("category", nc);
    p.set("limit", String(PAGE));
    p.set("offset", String(offset));
    return p;
  };

  const load = useCallback(async (nq: string, nc: AdminCategory | "", offset: number) => {
    const mine = ++seq.current;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/audit/admin-events?${query(nq, nc, offset)}`);
      const body = await res.json().catch(() => ({}));
      if (mine !== seq.current) return;
      if (!res.ok || !Array.isArray(body?.rows)) { setError("Couldn't load admin actions, please try again."); return; }
      setRows((prev) => (offset === 0 ? body.rows : [...prev, ...body.rows.filter((r: AdminRowJSON) => !prev.some((p) => p.id === r.id))]));
      setTotal(body.total ?? 0);
    } catch {
      if (mine === seq.current) setError("Couldn't load admin actions, please try again.");
    } finally {
      if (mine === seq.current) setBusy(false);
    }
  }, []);

  const groups = useMemo(() => mergeAdminRows(rows), [rows]);
  const more = rows.length < total;
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !more) return;
    const io = new IntersectionObserver((es) => { if (es[0]?.isIntersecting && !busy) load(q, cat, rows.length); }, { rootMargin: "400px" });
    io.observe(el);
    return () => io.disconnect();
  }, [more, busy, q, cat, rows.length, load]);

  const days: { key: string; label: string; groups: AdminRowJSON[][] }[] = [];
  for (const g of groups) {
    const k = dayKey(g[0].timestamp, zone);
    const last = days[days.length - 1];
    if (last?.key === k) last.groups.push(g);
    else days.push({ key: k, label: dayLabel(g[0].timestamp, zone), groups: [g] });
  }

  return (
    <div>
      {slot && createPortal(<a href={`/api/admin/audit/admin-export?${query(q, cat, 0)}`} className="btn"><NavIcon name="download" size={16} /> Export CSV</a>, slot)}

      <div className="au-frow au-atools">
        <label className="ma-search au-search">
          <NavIcon name="search" size={16} />
          <input type="search" placeholder="Search action, target or detail…" value={q} aria-label="Search admin actions"
            onChange={(e) => {
              const v = e.target.value;
              setQ(v);
              if (debounce.current) clearTimeout(debounce.current);
              debounce.current = setTimeout(() => load(v, cat, 0), 300);
            }} />
          {q && <button type="button" className="rs-clear" aria-label="Clear search" onClick={() => { setQ(""); load("", cat, 0); }}>×</button>}
        </label>
        <div className="seg au-cseg" role="group" aria-label="Category">
          {CATEGORIES.map((c) => (
            <button key={c.key || "all"} type="button" className={cat === c.key ? "seg-opt on" : "seg-opt"} aria-pressed={cat === c.key} onClick={() => { setCat(c.key); load(q, c.key, 0); }}>
              {c.dot && <span className={`rs-kdot ${c.dot}`} aria-hidden="true" />}{c.label}
            </button>
          ))}
        </div>
      </div>

      {error && <p className="notice error" role="alert">{error}</p>}

      {rows.length === 0 ? (
        <div className="au-empty">
          <span className="au-empty-ic"><NavIcon name="list" size={18} /></span>
          <b>{busy ? "Loading…" : q || cat ? "No admin actions match" : "No admin actions recorded yet"}</b>
          {!busy && <span className="cell-sub">{q || cat ? "Try another search or category." : "Changes made in this console are recorded here."}</span>}
        </div>
      ) : (
        <div className={busy ? "au-log busy" : "au-log"}>
          {days.map((d) => (
            <div key={d.key + d.groups[0][0].id}>
              <div className="au-day">{d.label}</div>
              {d.groups.map((g) => {
                const r = g[0];
                const c = CAT[adminCategory(r.action)];
                const ids = g.map((x) => x.targetId).filter((x): x is string => !!x);
                const isShown = shown.has(r.id);
                return (
                  // The whole entry opens the detail; its title is the keyboard target.
                  <div key={r.id} className={open?.[0].id === r.id ? "au-act sel" : "au-act"} onClick={() => setOpen(g)}>
                    <span className="mono au-t">{hm(r.timestamp, zone)}</span>
                    <span className={`au-cat ${c.dot}`} aria-hidden="true"><NavIcon name={c.icon!} size={16} /></span>
                    <span className="au-abody">
                      <span className="au-atitle">
                        <button type="button" className="au-atbtn" onClick={(e) => { e.stopPropagation(); setOpen(g); }}>{adminActionLabel(r.action)}</button>
                        {g.length > 1 && <span className="au-x">×{g.length}</span>}
                        <span className="au-code mono">{r.action}</span>
                      </span>
                      <span className="au-atext">{mergedText(g)}</span>
                      <span className="mono cell-sub au-target">
                        {r.targetType ?? "—"}{ids[0] ? ` · ${ids[0].slice(0, 8)}` : ""}{ids.length > 1 ? ` +${ids.length - 1}` : ""}
                        {ids.length > 1 && (
                          <button type="button" className="au-link" onClick={(e) => { e.stopPropagation(); setShown((s) => { const n = new Set(s); if (n.has(r.id)) n.delete(r.id); else n.add(r.id); return n; }); }}>
                            {isShown ? "Hide" : `Show ${ids.length} records`}
                          </button>
                        )}
                      </span>
                      {isShown && <span className="au-ids">{ids.map((id) => <span key={id} className="mono">{id}</span>)}</span>}
                    </span>
                    <span className="au-admin">
                      <span className="au-av sm" aria-hidden="true">{initials(r.actorEmail ?? "System")}</span>
                      <span className="cell-sub">{r.actorEmail ?? "System"}</span>
                    </span>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}
      <div ref={sentinel} className="au-end cell-sub">
        {rows.length > 0 && (more ? <>{busy ? "Loading older actions…" : "Scroll for older actions"} · first {rows.length} of {total}</> : <>All {total.toLocaleString("en-US")} admin actions shown</>)}
      </div>

      {open && (
        <AuditDrawer title={`Admin action${open[0].seq ? ` · seq #${open[0].seq}` : ""}`} onClose={() => setOpen(null)}>
          <div className="au-dpath"><b>{adminActionLabel(open[0].action)}</b>{open.length > 1 && <span className="au-x">×{open.length}</span>}<span className="au-code mono">{open[0].action}</span></div>
          <div className="au-dbox">{open.length > 1 ? mergedText(open) : open[0].summary}</div>
          <DetailList items={[
            ["Time", <span key="t" className="mono">{isoWithOffset(open[0].timestamp, zone)}</span>],
            ["Admin", open[0].actorEmail ?? "System"],
            ["IP", <span key="ip" className="mono">{open[0].clientIp ?? "—"}</span>],
            ["Target", open[0].targetType ?? "—"],
            ...(open.length === 1 ? [["Target ID", <span key="ti" className="mono">{open[0].targetId ?? "—"}</span>] as [string, React.ReactNode]] : []),
          ]} />
          {open.length > 1 && (
            <div className="au-dl-list">
              {open.map((x) => <div key={x.id}><span className="mono au-t">{isoWithOffset(x.timestamp, zone).slice(11, 19)}</span> {x.summary}</div>)}
            </div>
          )}
          {open[0].hash && (
            <div className="au-dchain">
              <b><NavIcon name="shield" size={14} /> Chained record</b>
              <div className="au-hashes mono">
                <span title={open[0].prevHash || "genesis"}>{open[0].prevHash ? `${open[0].prevHash.slice(0, 10)}…` : "genesis"}</span>
                <span aria-hidden="true">→</span>
                <span className="cur" title={open[0].hash}>#{open[0].seq} {open[0].hash.slice(0, 10)}…</span>
              </div>
            </div>
          )}
        </AuditDrawer>
      )}
    </div>
  );
}
