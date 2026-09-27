"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { LocalTime } from "@/app/(app)/_shell/local-time";
import { useTimezone } from "@/app/(app)/_shell/timezone-context";
import { TimezoneHint } from "@/app/(app)/_shell/effective-timezone";
import { startOfDayInZone, endOfDayInZone } from "@/lib/time/datetime-local";
import { DeleteRecordingButton } from "./delete-recording-button";
import { useConfirm } from "@/app/(app)/_shell/confirm-dialog";

export interface RecordingRowJSON {
  id: string;
  startedAt: string;
  lastEventAt: string;
  host: string;
  bytes: number;
  userId: string;
  userName: string | null;
  userEmail: string | null;
  siteId: string;
  siteName: string | null;
  format: string;
  protocol: string | null;
}

function formatBadge(r: RecordingRowJSON): string {
  if (r.format === "GUAC") return r.protocol ? r.protocol.toUpperCase() : "RDP";
  return "WEB";
}

type Opt = { id: string; name: string | null; email?: string | null };

type Filters = {
  q: string;
  cmd: string;
  userId: string;
  siteId: string;
  from: string;
  to: string;
};

const PAGE = 50;

function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
function duration(a: string, b: string): string {
  const s = Math.max(0, Math.round((new Date(b).getTime() - new Date(a).getTime()) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

export function RecordingsTable({
  users,
  sites,
  initialRows,
  initialTotal,
}: {
  users: Opt[];
  sites: Opt[];
  initialRows: RecordingRowJSON[];
  initialTotal: number;
}) {
  const tz = useTimezone();
  const [filters, setFilters] = useState<Filters>({ q: "", cmd: "", userId: "", siteId: "", from: "", to: "" });
  const [offset, setOffset] = useState(0);
  const [rows, setRows] = useState<RecordingRowJSON[]>(initialRows);
  const [total, setTotal] = useState(initialTotal);
  const [tooBroad, setTooBroad] = useState(false);
  const [partial, setPartial] = useState(false);
  const [unreachable, setUnreachable] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);
  const { confirm, dialog } = useConfirm();
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Bumped on every load() call; a response is applied only if it's still the
  // most recently issued request, so a slow stale response can't clobber
  // newer rows (e.g. filter change while a page fetch is still in flight).
  const requestIdRef = useRef(0);

  async function load(nextFilters: Filters, nextOffset: number) {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    try {
      const sp = new URLSearchParams();
      if (nextFilters.q.trim()) sp.set("q", nextFilters.q.trim());
      if (nextFilters.cmd.trim()) sp.set("cmd", nextFilters.cmd.trim());
      if (nextFilters.userId) sp.set("userId", nextFilters.userId);
      if (nextFilters.siteId) sp.set("siteId", nextFilters.siteId);
      // Calendar days in the display timezone (or the browser's), inclusive on both ends.
      const from = nextFilters.from ? startOfDayInZone(nextFilters.from, tz) : null;
      const to = nextFilters.to ? endOfDayInZone(nextFilters.to, tz) : null;
      if (from) sp.set("from", from.toISOString());
      if (to) sp.set("to", to.toISOString());
      sp.set("limit", String(PAGE));
      sp.set("offset", String(nextOffset));
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
      setRows(body.rows);
      setTotal(body.total);
      setTooBroad(body.tooBroad ?? false);
      setPartial(body.partial ?? false);
      setUnreachable(body.unreachableConnectors ?? []);
      setFilters(nextFilters);
      setOffset(nextOffset);
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }

  function updateFilter<K extends keyof Filters>(key: K, value: Filters[K]) {
    const nextFilters = { ...filters, [key]: value };
    void load(nextFilters, 0);
  }

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  const allOnPage = rows.length > 0 && rows.every((r) => selected.has(r.id));
  function toggleAll() {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allOnPage) rows.forEach((r) => next.delete(r.id));
      else rows.forEach((r) => next.add(r.id));
      return next;
    });
  }
  async function deleteSelected() {
    const ids = [...selected];
    if (ids.length === 0) return;
    if (!(await confirm(`Delete ${ids.length} recording${ids.length === 1 ? "" : "s"}? This can't be undone.`, { danger: true, confirmLabel: "Delete" }))) return;
    setDeleting(true);
    try {
      await Promise.all(ids.map((id) => fetch(`/api/admin/recordings/${id}`, { method: "DELETE" }).catch(() => null)));
      setSelected(new Set());
      await load(filters, 0);
    } finally {
      setDeleting(false);
    }
  }

  const start = total === 0 ? 0 : offset + 1;
  const end = Math.min(offset + PAGE, total);

  return (
    <div>
      <div className="card">
        <div className="filter-bar">
        <div className="field field-search">
          <label className="field-label" htmlFor="rec-filter-q">Search</label>
          <input
            id="rec-filter-q"
            type="search"
            className="input"
            placeholder="Search host…"
            value={filters.q}
            onChange={(e) => {
              const q = e.target.value;
              setFilters((prev) => ({ ...prev, q }));
              if (debounceRef.current) clearTimeout(debounceRef.current);
              debounceRef.current = setTimeout(() => void load({ ...filters, q }, 0), 300);
            }}
          />
        </div>
        <div className="field field-search">
          <label className="field-label" htmlFor="rec-filter-cmd">Search commands</label>
          <input
            id="rec-filter-cmd"
            type="search"
            className="input"
            placeholder="e.g. rm -rf, systemctl…"
            value={filters.cmd}
            onChange={(e) => {
              const cmd = e.target.value;
              setFilters((prev) => ({ ...prev, cmd }));
              if (debounceRef.current) clearTimeout(debounceRef.current);
              debounceRef.current = setTimeout(() => void load({ ...filters, cmd }, 0), 300);
            }}
          />
        </div>
        <div className="field">
          <label className="field-label" htmlFor="rec-filter-site">Resource</label>
          <select id="rec-filter-site" className="select" value={filters.siteId} onChange={(e) => updateFilter("siteId", e.target.value)}>
            <option value="">All resources</option>
            {sites.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name ?? s.id}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label className="field-label" htmlFor="rec-filter-user">Vendor</label>
          <select id="rec-filter-user" className="select" value={filters.userId} onChange={(e) => updateFilter("userId", e.target.value)}>
            <option value="">All vendors</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name ?? u.email ?? u.id}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label className="field-label" htmlFor="rec-filter-from">From<TimezoneHint /></label>
          <input id="rec-filter-from" type="date" className="input" value={filters.from} onChange={(e) => updateFilter("from", e.target.value)} />
        </div>
        <div className="field">
          <label className="field-label" htmlFor="rec-filter-to">To<TimezoneHint /></label>
          <input id="rec-filter-to" type="date" className="input" value={filters.to} onChange={(e) => updateFilter("to", e.target.value)} />
        </div>
        </div>
      </div>

      {dialog}
      {selected.size > 0 && (
        <div className="card-head" style={{ marginTop: "1rem" }}>
          <span className="cell-sub">{selected.size} selected</span>
          <button type="button" className="btn sm danger" onClick={deleteSelected} disabled={deleting}>
            {deleting ? "Deleting…" : `Delete selected (${selected.size})`}
          </button>
        </div>
      )}

      {/* An incomplete answer is shown ABOVE the results, not instead of them: the
          rows that did come back are real, and hiding them would be its own
          inaccuracy. Reading "no matches" when a connector could not be searched is
          the failure this banner exists to prevent -- in an investigation that reads
          as proof nothing happened. */}
      {partial ? (
        <div className="warn" role="status">
          This answer is incomplete: {unreachable.length > 0
            ? `${unreachable.length} connector${unreachable.length === 1 ? "" : "s"} could not be searched`
            : "some recordings could not be reached"}
          . Recordings are stored on their connector, so anything they hold is not
          included here. Results below are accurate for the connectors that answered.
        </div>
      ) : null}

      {tooBroad ? (
        <div className="empty">Too many recordings to search by command — narrow by vendor, resource, or date and try again.</div>
      ) : rows.length === 0 ? (
        <div className="empty">{loading ? "Loading…" : "No recordings match these filters."}</div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th><input type="checkbox" aria-label="Select all on page" checked={allOnPage} onChange={toggleAll} /></th>
                <th>Started</th>
                <th>User</th>
                <th>Resource</th>
                <th>Type</th>
                <th>Duration</th>
                <th>Size</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td><input type="checkbox" aria-label="Select recording" checked={selected.has(r.id)} onChange={() => toggle(r.id)} /></td>
                  <td className="cell-sub"><LocalTime iso={r.startedAt} /></td>
                  <td>
                    {r.userName ?? "—"}
                    {r.userEmail && <div className="cell-sub">{r.userEmail}</div>}
                  </td>
                  <td>{r.siteName ?? r.host}</td>
                  <td><span className="pill">{formatBadge(r)}</span></td>
                  <td className="cell-sub">{duration(r.startedAt, r.lastEventAt)}</td>
                  <td className="cell-sub">{humanBytes(r.bytes)}</td>
                  <td className="row-actions">
                    <Link href={`/admin/recordings/${r.id}`} className="btn sm">Watch</Link>
                    <DeleteRecordingButton id={r.id} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="card-head" style={{ marginTop: "1rem" }}>
        <span className="cell-sub">{loading ? "Loading…" : `${start}–${end} of ${total}`}</span>
        <div className="row-actions">
          <button type="button" className="btn sm" disabled={offset === 0 || loading} onClick={() => void load(filters, Math.max(0, offset - PAGE))}>
            Previous
          </button>
          <button type="button" className="btn sm" disabled={end >= total || loading} onClick={() => void load(filters, offset + PAGE)}>
            Next
          </button>
        </div>
      </div>
    </div>
  );
}
