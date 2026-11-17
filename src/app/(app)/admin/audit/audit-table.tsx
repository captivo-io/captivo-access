"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { LocalTime } from "@/app/(app)/_shell/local-time";
import { useTimezone } from "@/app/(app)/_shell/timezone-context";
import { TimezoneHint } from "@/app/(app)/_shell/effective-timezone";
import { NavIcon } from "@/app/(app)/_shell/nav-icons";
import { parseDatetimeLocal, formatDatetimeLocal } from "@/lib/time/datetime-local";
import { CopyButton } from "@/app/(app)/_shell/copy-button";
import { accessReasonLabel, transferBadge } from "@/lib/audit/access-format";
import type { AuditSummary } from "@/lib/audit/summary";
import { AuditDrawer, DetailList } from "./audit-drawer";

export type AuditRowJSON = {
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
  userAgent?: string | null;
};

type Filters = {
  q: string;
  userId: string;
  siteId: string;
  decision: "" | "ALLOW" | "DENY";
  kind: "" | "file";
  from: string;
  to: string;
};

const LIMIT = 50;
const EMPTY: Filters = { q: "", userId: "", siteId: "", decision: "", kind: "", from: "", to: "" };

// datetime-local wall time → ISO, interpreted in the display timezone (or the
// browser's when none is configured) — the same zone the table shows.
function toIso(datetimeLocal: string, tz: string | null): string | undefined {
  if (!datetimeLocal) return undefined;
  return parseDatetimeLocal(datetimeLocal, tz)?.toISOString();
}

function buildParams(filters: Filters, tz: string | null, limit: number, offset: number): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.q) params.set("q", filters.q);
  if (filters.userId) params.set("userId", filters.userId);
  if (filters.siteId) params.set("siteId", filters.siteId);
  if (filters.decision) params.set("decision", filters.decision);
  if (filters.kind) params.set("kind", filters.kind);
  const fromIso = toIso(filters.from, tz);
  if (fromIso) params.set("from", fromIso);
  const toIsoValue = toIso(filters.to, tz);
  if (toIsoValue) params.set("to", toIsoValue);
  params.set("limit", String(limit));
  params.set("offset", String(offset));
  return params;
}

// URL params carry ISO instants; the inputs hold wall times in the display zone.
function isoToLocal(v: string | null, tz: string | null): string {
  if (!v) return "";
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? "" : formatDatetimeLocal(d, tz);
}

function filtersFromParams(sp: URLSearchParams, tz: string | null): Filters {
  const decision = sp.get("decision");
  return {
    q: sp.get("q") ?? "",
    userId: sp.get("userId") ?? "",
    siteId: sp.get("siteId") ?? "",
    decision: decision === "ALLOW" || decision === "DENY" ? decision : "",
    kind: sp.get("kind") === "file" ? "file" : "",
    from: isoToLocal(sp.get("from"), tz),
    to: isoToLocal(sp.get("to"), tz),
  };
}

export function formatBytes(raw: string): string {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const v = n / 1024 ** i;
  return `${i === 0 ? v : v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

function Request({ r }: { r: AuditRowJSON }) {
  const b = transferBadge(r.method);
  return (
    <span className="au-req">
      {b.isTransfer
        ? <span className={`ft-badge ${b.direction}${b.partial ? " partial" : ""}`}>{b.direction === "download" ? "↓" : "↑"} {b.label}</span>
        : <span className="au-verb">{r.method}</span>}
      <span className="mono au-path" title={r.path}>{r.path}</span>
    </span>
  );
}

function Decision({ r }: { r: AuditRowJSON }) {
  return r.decision === "ALLOW"
    ? <span className="rs-pill up">Allowed</span>
    : <span className="rs-pill down" title={accessReasonLabel(r.reason) ?? undefined}>Denied</span>;
}

export function AuditTable({
  users,
  sites,
  initialRows,
  initialTotal,
  summary,
}: {
  users: { id: string; name: string; email: string }[];
  sites: { id: string; name: string }[];
  initialRows: AuditRowJSON[];
  initialTotal: number;
  summary: AuditSummary;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const tz = useTimezone();
  const [filters, setFilters] = useState<Filters>(() => filtersFromParams(new URLSearchParams(searchParams.toString()), tz));
  const [offset, setOffset] = useState(0);
  const [rows, setRows] = useState<AuditRowJSON[]>(initialRows);
  const [total, setTotal] = useState(initialTotal);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<AuditRowJSON | null>(null);
  const [moreOpen, setMoreOpen] = useState(() => Boolean(searchParams.get("from") || searchParams.get("to")));
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => setSlot(document.getElementById("au-head-actions")), []);

  async function load(nextFilters: Filters, nextOffset: number) {
    setBusy(true);
    setError(null);
    setFilters(nextFilters);
    try {
      const params = buildParams(nextFilters, tz, LIMIT, nextOffset);
      const res = await fetch(`/api/admin/audit?${params.toString()}`);
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !Array.isArray(body?.rows)) {
        setError("Couldn't load audit events, please try again.");
        return;
      }
      setRows(body.rows);
      setTotal(typeof body.total === "number" ? body.total : 0);
      setOffset(nextOffset);
      const url = params.toString();
      router.replace(url ? `${pathname}?${url}` : pathname, { scroll: false });
    } catch {
      setError("Couldn't load audit events, please try again.");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    const seeded = filtersFromParams(new URLSearchParams(searchParams.toString()), tz);
    const hasAny = Object.values(seeded).some((v) => v !== "");
    if (hasAny) load(seeded, 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function set<K extends keyof Filters>(key: K, value: Filters[K]) {
    load({ ...filters, [key]: value }, 0);
  }

  function search(q: string) {
    setFilters((prev) => ({ ...prev, q }));
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => load({ ...filters, q }, 0), 300);
  }

  const csvHref = `/api/admin/audit/export?${buildParams(filters, tz, LIMIT, 0).toString()}`;
  const filtered = JSON.stringify(filters) !== JSON.stringify(EMPTY);
  const first = total === 0 ? 0 : offset + 1;
  const last = Math.min(offset + rows.length, total);

  return (
    <div>
      {slot && createPortal(<a href={csvHref} className="btn sm"><NavIcon name="download" size={15} /> Export CSV</a>, slot)}

      <div className="kstrip au-summary">
        <div className="kcell">
          <span className="kcell-k"><span className="rs-kdot p" />Requests · 24 h</span>
          <span className="kcell-row"><span className="kcell-v">{summary.requests.toLocaleString()}</span></span>
        </div>
        <button type="button" className={`kcell rs-cell bad${filters.decision === "DENY" ? " on" : ""}`} onClick={() => set("decision", filters.decision === "DENY" ? "" : "DENY")} aria-pressed={filters.decision === "DENY"}>
          <span className="kcell-k"><span className="rs-kdot bad" />Denied · 24 h</span>
          <span className="kcell-row">
            <span className="kcell-v">{summary.denied.toLocaleString()}</span>
            <span className="kcell-s">{summary.requests ? `${((summary.denied / summary.requests) * 100).toFixed(summary.denied && summary.denied * 100 < summary.requests ? 1 : 0)}% of requests` : "nothing yet"}</span>
          </span>
        </button>
        <button type="button" className={`kcell rs-cell${filters.kind === "file" ? " on" : ""}`} onClick={() => set("kind", filters.kind === "file" ? "" : "file")} aria-pressed={filters.kind === "file"}>
          <span className="kcell-k"><span className="rs-kdot warn" />File transfers · 24 h</span>
          <span className="kcell-row"><span className="kcell-v">{summary.transfers.toLocaleString()}</span><span className="kcell-s">uploads and downloads</span></span>
        </button>
        <div className="kcell">
          <span className="kcell-k"><span className="rs-kdot ok" />People · 24 h</span>
          <span className="kcell-row"><span className="kcell-v">{summary.people.toLocaleString()}</span><span className="kcell-s">signed-in users</span></span>
        </div>
      </div>

      <div className="rs-tools">
        <label className="ma-search rs-search">
          <NavIcon name="search" size={16} />
          <input type="search" placeholder="Search path, host, user, company, IP…" value={filters.q} onChange={(e) => search(e.target.value)} aria-label="Search" />
          {filters.q && <button type="button" className="rs-clear" aria-label="Clear search" onClick={() => load({ ...filters, q: "" }, 0)}>×</button>}
        </label>
        <div className="seg" role="group" aria-label="Decision">
          {([["", "All"], ["ALLOW", "Allowed"], ["DENY", "Denied"]] as const).map(([k, l]) => (
            <button key={k} type="button" className={filters.decision === k ? "seg-opt on" : "seg-opt"} aria-pressed={filters.decision === k} onClick={() => set("decision", k)}>{l}</button>
          ))}
        </div>
        <select className="select au-select" value={filters.userId} onChange={(e) => set("userId", e.target.value)} aria-label="Person">
          <option value="">Everyone</option>
          {users.map((u) => <option key={u.id} value={u.id}>{u.name} ({u.email})</option>)}
        </select>
        <select className="select au-select" value={filters.siteId} onChange={(e) => set("siteId", e.target.value)} aria-label="Resource">
          <option value="">All resources</option>
          {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <button type="button" className={moreOpen || filters.from || filters.to ? "btn sm au-more on" : "btn sm au-more"} onClick={() => setMoreOpen((v) => !v)} aria-expanded={moreOpen}>
          <NavIcon name="clock" size={15} /> Time range{filters.from || filters.to ? " ·" : ""}
        </button>
      </div>

      {moreOpen && (
        <div className="au-range">
          <label>
            <span className="kcell-k">From<TimezoneHint /></span>
            <input type="datetime-local" className="input" value={filters.from} onChange={(e) => set("from", e.target.value)} />
          </label>
          <label>
            <span className="kcell-k">To<TimezoneHint /></span>
            <input type="datetime-local" className="input" value={filters.to} onChange={(e) => set("to", e.target.value)} />
          </label>
          {(filters.from || filters.to) && <button type="button" className="btn sm" onClick={() => load({ ...filters, from: "", to: "" }, 0)}>Clear range</button>}
        </div>
      )}

      {error && <p className="notice error" role="alert">{error}</p>}

      {rows.length === 0 ? (
        <div className="rs-none">
          {busy ? "Loading…" : filtered ? "No requests match these filters." : "No requests yet. Every request through a connector lands here."}
          {filtered && !busy && <button type="button" className="btn sm" onClick={() => load(EMPTY, 0)}>Clear filters</button>}
        </div>
      ) : (
        <div className={busy ? "table-wrap au-table busy" : "table-wrap au-table"}>
          <table className="table">
            <thead>
              <tr><th>Time</th><th>Person</th><th>Resource</th><th>Request</th><th>Result</th><th className="au-hide-sm">IP</th></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} tabIndex={0} className={open?.id === r.id ? "on" : undefined} onClick={() => setOpen(r)} onKeyDown={(e) => { if (e.key === "Enter") setOpen(r); }}>
                  <td className="au-time"><LocalTime iso={r.timestamp} mode="short" /></td>
                  <td>
                    <div className="au-who">{r.userName ?? r.userEmail ?? <span className="muted">Anonymous</span>}</div>
                    {r.company && <div className="cell-sub">{r.company}</div>}
                  </td>
                  <td><div className="au-who">{r.siteName ?? r.host}</div>{r.siteName && <div className="cell-sub mono">{r.host}</div>}</td>
                  <td className="au-req-cell"><Request r={r} /></td>
                  <td>
                    <span className="au-result"><Decision r={r} /><span className="mono cell-sub">{r.status}</span></span>
                    {r.decision === "DENY" && r.reason && <div className="cell-sub au-reason">{accessReasonLabel(r.reason)}</div>}
                  </td>
                  <td className="cell-sub mono au-hide-sm">{r.clientIp ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="au-foot">
            <span className="cell-sub">{first.toLocaleString()}–{last.toLocaleString()} of {total.toLocaleString()}</span>
            <span className="row-actions">
              <button type="button" className="btn sm" onClick={() => load(filters, Math.max(0, offset - LIMIT))} disabled={offset === 0 || busy}>← Newer</button>
              <button type="button" className="btn sm" onClick={() => load(filters, offset + LIMIT)} disabled={offset + LIMIT >= total || busy}>Older →</button>
            </span>
          </div>
        </div>
      )}

      {open && (
        <AuditDrawer
          title={open.decision === "ALLOW" ? "Allowed request" : "Denied request"}
          badge={<Decision r={open} />}
          onClose={() => setOpen(null)}
        >
          {open.decision === "DENY" && open.reason && <div className="au-why"><b>Why:</b> {accessReasonLabel(open.reason)}</div>}
          <DetailList items={[
            ["Time", <LocalTime key="t" iso={open.timestamp} mode="full" />],
            ["Person", open.userName ? <>{open.userName}{open.userEmail && <div className="cell-sub">{open.userEmail}</div>}</> : (open.userEmail ?? "Anonymous")],
            ["Company", open.company ?? "—"],
            ["Resource", open.siteName ?? "—"],
            ["Host", <span key="h" className="mono">{open.host}</span>],
            ["Request", <span key="r" className="au-copyline"><Request r={open} /><CopyButton value={`${open.method} ${open.path}`} label="Copy" /></span>],
            ["Status", <span key="s" className="mono">{open.status}</span>],
            ...(open.decision === "ALLOW" && open.reason ? [["Note", accessReasonLabel(open.reason)] as [string, React.ReactNode]] : []),
            ["Sent", formatBytes(open.bytesOut)],
            ["IP address", <span key="ip" className="mono">{open.clientIp ?? "—"}</span>],
            ["Browser", <span key="ua" className="au-ua">{open.userAgent || "—"}</span>],
            ["Event ID", <span key="id" className="mono cell-sub">{open.id}</span>],
          ]} />
          <div className="au-drawer-actions">
            {open.userId && <button type="button" className="btn sm" onClick={() => { set("userId", open.userId!); setOpen(null); }}>Only this person</button>}
            {open.siteId && <button type="button" className="btn sm" onClick={() => { set("siteId", open.siteId!); setOpen(null); }}>Only this resource</button>}
            {open.clientIp && <button type="button" className="btn sm" onClick={() => { load({ ...filters, q: open.clientIp! }, 0); setOpen(null); }}>Search this IP</button>}
          </div>
        </AuditDrawer>
      )}
    </div>
  );
}
