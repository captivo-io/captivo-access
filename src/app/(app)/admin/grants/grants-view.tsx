"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Modal } from "@/app/(app)/_shell/modal";
import { useZone, fmt, hm, dayKey } from "@/app/(app)/admin/audit/audit-zone";
import { grantKpis, matchesFilter, limitDays, PERMANENT_HINT_AT, type GrantFilter } from "@/lib/access/grant-view";
import type { GrantRowJSON, SiteTile } from "@/lib/access/grant-rows";
import { GrantDialogBody, RoleChip, initials, type GrantUser, type ExistingGrant } from "./grant-dialog";
import { EditGrantBody } from "./edit-grant-dialog";
import { TestAccessWidget } from "./test-access-widget";
import { ResourceIcon } from "@/components/resource-icon";

const DAY_MS = 86_400_000;
const LIMIT_DAYS = 30;
const STATE_ORDER = { active: 0, scheduled: 1, ended: 2, pending: 3 } as const;
const SEG: { key: GrantFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "active", label: "Active" },
  { key: "perm", label: "Permanent" },
  { key: "scheduled", label: "Scheduled" },
  { key: "ended", label: "Ended" },
];

type Dialog = { userId?: string; siteIds?: string[] } | null;
type Toast = { msg: string; ok: boolean } | null;

export function GrantsView({
  head, pending, rows, users, sites, canApprove, canConfigure, maxGrantDays, serverNow, initialFilter, openNew, openUser = null,
}: {
  /** The page title block, and the pending-requests card shown under the header. */
  head: React.ReactNode;
  pending: React.ReactNode;
  rows: GrantRowJSON[];
  users: GrantUser[];
  sites: SiteTile[];
  canApprove: boolean;
  canConfigure: boolean;
  maxGrantDays: number;
  serverNow: number;
  initialFilter: GrantFilter;
  openNew: boolean;
  /** Preselect this user when the dialog opens on arrival (People → Grant access). */
  openUser?: string | null;
}) {
  const router = useRouter();
  const zone = useZone();
  // The server's clock until mount, so the first render matches the HTML.
  const [now, setNow] = useState(serverNow);
  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const [filter, setFilter] = useState<GrantFilter>(initialFilter);
  const [q, setQ] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dialog, setDialog] = useState<Dialog>(openNew && canApprove ? { userId: openUser ?? undefined } : null);
  const [edit, setEdit] = useState<GrantRowJSON | null>(null);
  const [toast, setToast] = useState<Toast>(null);
  const [bulkAsk, setBulkAsk] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [check, setCheck] = useState(false);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2600);
    return () => clearTimeout(t);
  }, [toast]);

  const userMap = useMemo(() => new Map(users.map((u) => [u.id, u])), [users]);
  const siteMap = useMemo(() => new Map(sites.map((s) => [s.id, s])), [sites]);
  const kpis = useMemo(() => grantKpis(rows), [rows]);
  const existing = useMemo<ExistingGrant[]>(() => rows.filter((r) => r.state === "active" || r.state === "scheduled").map((r) => ({
    userId: r.userId, siteId: r.siteId,
    startsAt: r.startsAt ? Date.parse(r.startsAt) : null, endsAt: r.endsAt ? Date.parse(r.endsAt) : null, recurring: r.kind === "recurring",
    label: r.kind === "recurring" ? `access ${r.days} ${r.hours}` : r.state === "scheduled" && r.startsAt ? `access from ${shortDate(r.startsAt)}` : r.endsAt ? `access until ${shortDate(r.endsAt)}` : "permanent access",
  })), [rows]);
  const limit = limitDays(LIMIT_DAYS, maxGrantDays);

  const visible = useMemo(() => {
    const t = q.trim().toLowerCase();
    return rows.filter((r) => {
      if (!matchesFilter(r, filter)) return false;
      if (!t) return true;
      const u = userMap.get(r.userId);
      const s = siteMap.get(r.siteId);
      return [u?.name, u?.email, s?.name, s?.host, r.note].some((v) => v?.toLowerCase().includes(t));
    });
  }, [rows, filter, q, userMap, siteMap]);

  const groups = useMemo(() => {
    const by = new Map<string, GrantRowJSON[]>();
    for (const r of visible) by.set(r.userId, [...(by.get(r.userId) ?? []), r]);
    for (const list of by.values()) list.sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || b.createdAt.localeCompare(a.createdAt));
    const name = (id: string) => (userMap.get(id)?.name || userMap.get(id)?.email || "").toLowerCase();
    return [...by.entries()].sort(([a], [b]) => name(a).localeCompare(name(b)));
  }, [visible, userMap]);

  // Selection follows what is shown: a filter change drops hidden rows.
  useEffect(() => {
    const shown = new Set(visible.map((r) => r.id));
    setSelected((s) => (([...s].every((id) => shown.has(id))) ? s : new Set([...s].filter((id) => shown.has(id)))));
  }, [visible]);
  useEffect(() => { if (selected.size === 0) setBulkAsk(false); }, [selected]);

  function done(msg: string) {
    setToast({ msg, ok: true });
    router.refresh();
  }
  const fail = (msg: string) => setToast({ msg, ok: false });

  async function patch(r: GrantRowJSON, endsAt: Date, msg: string) {
    try {
      const res = await fetch(`/api/admin/grants/${r.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ endsAt: endsAt.toISOString() }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok && body?.ok) return done(msg);
      fail(body?.error === "grant_exceeds_max" ? "That is longer than the policy allows." : "Couldn't update the grant. Try again.");
    } catch {
      fail("Couldn't update the grant. Try again.");
    }
  }

  async function revoke(r: GrantRowJSON) {
    try {
      const res = await fetch(`/api/admin/grants?id=${encodeURIComponent(r.id)}`, { method: "DELETE" });
      const body = await res.json().catch(() => ({}));
      if (res.ok && body?.ok) return done("Access revoked");
    } catch { /* fall through */ }
    fail("Couldn't revoke the grant. Try again.");
  }

  async function bulk(action: "revoke" | "limit") {
    setBulkBusy(true);
    try {
      const res = await fetch("/api/admin/grants/bulk", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids: [...selected], action, days: LIMIT_DAYS }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body?.ok) { fail("Couldn't update the grants. Try again."); return; }
      const n = body.done as number;
      const skipped = body.skipped as number;
      const what = action === "revoke" ? `${n} ${n === 1 ? "grant" : "grants"} revoked` : `${n} ${n === 1 ? "grant ends" : "grants end"} within ${body.days} days`;
      setSelected(new Set());
      done(skipped ? `${what} · ${skipped} unchanged` : what);
    } catch {
      fail("Couldn't update the grants. Try again.");
    } finally {
      setBulkBusy(false);
      setBulkAsk(false);
    }
  }

  const toggle = (ids: string[], on: boolean) =>
    setSelected((s) => { const n = new Set(s); for (const id of ids) { if (on) n.add(id); else n.delete(id); } return n; });

  const ctx: RowCtx = {
    zone, now, canApprove, canConfigure, limit,
    site: (id) => siteMap.get(id),
    selected,
    onSelect: (id, on) => toggle([id], on),
    onEdit: setEdit,
    onPatch: patch,
    onRevoke: revoke,
    onGrantAgain: (r) => setDialog({ userId: r.userId, siteIds: [r.siteId] }),
  };

  const kcell = (f: GrantFilter, dot: string, label: string, value: number, sub: string, subTone?: string) => (
    <button type="button" className={filter === f ? "kcell on" : "kcell"} aria-pressed={filter === f} onClick={() => setFilter(filter === f ? "all" : f)}>
      <span className="kcell-k"><span className={`rs-kdot ${dot}`} />{label}</span>
      <span className="kcell-row"><span className="kcell-v">{value}</span><span className={subTone ? `kcell-s ${subTone}` : "kcell-s"}>{sub}</span></span>
    </button>
  );

  return (
    <>
      <div className="page-head">
        {head}
        <div className="row-actions">
          {users.length > 0 && sites.length > 0 && <button type="button" className="btn" onClick={() => setCheck(true)}>Check access</button>}
          <a className="btn" href="/api/admin/grants/export" download>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 4v11" /><path d="m7 10 5 5 5-5" /><path d="M5 20h14" /></svg>
            Export CSV
          </a>
          {canApprove && users.length > 0 && sites.length > 0 && <button type="button" className="btn primary" onClick={() => setDialog({})}>+ New grant</button>}
        </div>
      </div>
      {pending}

      <div className="kstrip gr-kpis">
        {kcell("active", "ok", "Active", kpis.active, `across ${kpis.activePeople} ${kpis.activePeople === 1 ? "person" : "people"}`)}
        {kcell("perm", "warn", "Permanent", kpis.perm, kpis.perm ? "review these" : "none", kpis.perm ? "t-warn" : undefined)}
        {kcell("scheduled", "p", "Scheduled", kpis.scheduled, "later or recurring")}
        {kcell("soon", "violet", "Ending in 24 h", kpis.soon, kpis.soon ? "can be extended" : "none")}
      </div>

      {kpis.perm >= PERMANENT_HINT_AT && filter !== "perm" && (
        <div className="gr-hint" role="status">
          <span className="gr-hint-ic" aria-hidden="true">∞</span>
          <span className="gr-hint-t"><b>{kpis.perm} of {kpis.live} grants are permanent.</b> Set an end date on vendor and admin grants; expired access closes on its own.</span>
          <button type="button" className="btn sm gr-hint-btn" onClick={() => setFilter("perm")}>Show permanent →</button>
        </div>
      )}

      <div className="gr-tools">
        <label className="ma-search">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search user, resource or note…" aria-label="Search grants" />
        </label>
        <div className="seg" role="group" aria-label="Status">
          {SEG.map((f) => (
            <button key={f.key} type="button" className={filter === f.key ? "seg-opt on" : "seg-opt"} aria-pressed={filter === f.key} onClick={() => setFilter(f.key)}>
              {f.label}<span className="mono t-muted">{kpis[f.key]}</span>
            </button>
          ))}
        </div>
        {filter === "soon" && <button type="button" className="fpill on" onClick={() => setFilter("all")}>Ending in 24 h ×</button>}
      </div>

      {rows.length === 0 ? (
        <div className="au-empty">
          <span className="au-empty-ic" aria-hidden="true">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3l7 3v6c0 4-3 7-7 8-4-1-7-4-7-8V6z" /><path d="M9 12l2 2 4-4" /></svg>
          </span>
          <b>No grants yet</b>
          <span className="cell-sub">A grant lets a user reach a resource, for a while or for good. Every grant is logged.</span>
          {canApprove && <button type="button" className="btn primary" onClick={() => setDialog({})}>+ New grant</button>}
        </div>
      ) : groups.length === 0 ? (
        <div className="au-empty">
          <b>No grants match these filters</b>
          <button type="button" className="btn" onClick={() => { setQ(""); setFilter("all"); }}>Clear filters</button>
        </div>
      ) : (
        groups.map(([userId, list]) => {
          const u = userMap.get(userId);
          const open = !collapsed.has(userId);
          const ids = list.map((r) => r.id);
          const all = ids.every((id) => selected.has(id));
          const userPerm = list.filter((r) => r.permanent).length;
          return (
            <section key={userId} className="gr-group">
              <div className={open ? "gr-ghead open" : "gr-ghead"}>
                <input type="checkbox" checked={all} onChange={() => toggle(ids, !all)} aria-label={`Select all grants of ${u?.name ?? "this user"}`} />
                <span className="gr-av" aria-hidden="true">{initials(u?.name ?? "", u?.email ?? "?")}</span>
                <span className="gr-who">
                  <span className="gr-who-n">{u?.name || u?.email || "Deleted user"}{u && <RoleChip role={u.role} />}</span>
                  <span className="mono t-muted">{u?.email}</span>
                </span>
                <span className="gr-count">{list.length} {list.length === 1 ? "grant" : "grants"}{userPerm ? ` · ${userPerm} permanent` : ""}</span>
                {canApprove && u && <button type="button" className="btn sm" onClick={() => setDialog({ userId })}>+ Grant</button>}
                <button type="button" className="gr-chev" aria-expanded={open} aria-label={open ? "Collapse" : "Expand"}
                  onClick={() => setCollapsed((s) => { const n = new Set(s); if (open) n.add(userId); else n.delete(userId); return n; })}>
                  <span aria-hidden="true">▾</span>
                </button>
              </div>
              {open && (
                <div className="gr-rows">
                  <div className="gr-row gr-cols" aria-hidden="true"><span /><span>Resource</span><span>Window</span><span>Note</span><span>Status</span><span /></div>
                  {list.map((r) => <Row key={r.id} r={r} c={ctx} />)}
                </div>
              )}
            </section>
          );
        })
      )}

      {selected.size > 0 && (
        <div className="gr-bulk" role="region" aria-label="Selected grants">
          <span className="gr-bulk-n">{selected.size} {selected.size === 1 ? "grant" : "grants"} selected</span>
          {canConfigure && <button type="button" className="gr-bulk-b" disabled={bulkBusy} onClick={() => void bulk("limit")}>Limit to {limit} days</button>}
          {canApprove && (bulkAsk ? (
            <button type="button" className="gr-bulk-b danger" disabled={bulkBusy} onClick={() => void bulk("revoke")}>{bulkBusy ? "Revoking…" : `Revoke ${selected.size} ${selected.size === 1 ? "grant" : "grants"}?`}</button>
          ) : (
            <button type="button" className="gr-bulk-b danger" onClick={() => setBulkAsk(true)}>Revoke</button>
          ))}
          <button type="button" className="gr-bulk-x" aria-label="Clear selection" onClick={() => setSelected(new Set())}>×</button>
        </div>
      )}

      <Modal open={dialog !== null} onClose={() => setDialog(null)} title="New grant" subtitle="The user can reach these resources within this window. Every grant is logged." size="md">
        {dialog && (
          <GrantDialogBody users={users} sites={sites} existing={existing} maxGrantDays={maxGrantDays}
            initialUserId={dialog.userId} initialSiteIds={dialog.siteIds}
            onClose={() => setDialog(null)}
            onDone={(n, userId) => {
              setDialog(null);
              setFilter("all");
              setCollapsed((s) => { const x = new Set(s); x.delete(userId); return x; });
              done(n === 1 ? "Access granted" : `Access granted to ${n} resources`);
            }} />
        )}
      </Modal>
      <Modal open={edit !== null} onClose={() => setEdit(null)} title="Edit grant" subtitle={edit ? `${userMap.get(edit.userId)?.name ?? ""} · ${siteMap.get(edit.siteId)?.name ?? ""}` : undefined} size="sm">
        {edit && <EditGrantBody id={edit.id} endsAt={edit.endsAt} note={edit.note} onClose={() => setEdit(null)} onDone={() => { setEdit(null); done("Grant updated"); }} />}
      </Modal>

      <Modal open={check} onClose={() => setCheck(false)} title="Check access" size="sm">
        {check && <TestAccessWidget users={users} sites={sites} />}
      </Modal>

      {toast && <div className="toast" role="status"><span className={toast.ok ? undefined : "t-bad"}>{toast.ok ? "✓" : "!"}</span>{toast.msg}</div>}
    </>
  );
}

interface RowCtx {
  zone: string;
  now: number;
  canApprove: boolean;
  canConfigure: boolean;
  limit: number;
  site: (id: string) => SiteTile | undefined;
  selected: Set<string>;
  onSelect: (id: string, on: boolean) => void;
  onEdit: (r: GrantRowJSON) => void;
  onPatch: (r: GrantRowJSON, endsAt: Date, msg: string) => Promise<void>;
  onRevoke: (r: GrantRowJSON) => Promise<void>;
  onGrantAgain: (r: GrantRowJSON) => void;
}

const STATUS = {
  active: { label: "Active", cls: "ok" },
  scheduled: { label: "Scheduled", cls: "p" },
  ended: { label: "Ended", cls: "muted" },
  pending: { label: "Awaiting approval", cls: "warn" },
} as const;

function Row({ r, c }: { r: GrantRowJSON; c: RowCtx }) {
  const s = c.site(r.siteId);
  const on = c.selected.has(r.id);
  const cls = ["gr-row", on && "sel", r.state === "ended" && "ended"].filter(Boolean).join(" ");
  return (
    <div className={cls}>
      <input type="checkbox" checked={on} onChange={() => c.onSelect(r.id, !on)} aria-label={`Select ${s?.name ?? "grant"}`} />
      <span className="gr-res">
        {s ? <ResourceIcon name={s.icon} color={s.color} logoUrl={s.logoUrl} logoBg={s.logoBg} size={34} /> : <ResourceIcon name="server" color="slate" size={34} />}
        <span className="gr-res-t"><b>{s?.name ?? "Deleted resource"}</b>{s && <span className="mono t-muted"><span className="rs-proto-l">{s.proto}</span>{s.host ? ` · ${s.host}` : ""}</span>}</span>
      </span>
      <Window r={r} zone={c.zone} now={c.now} />
      <span className={r.note ? "gr-note" : "gr-note none"} title={r.note ?? undefined}>{r.note || "—"}</span>
      <span className={`gr-st ${STATUS[r.state].cls}`}><span aria-hidden="true" />{STATUS[r.state].label}</span>
      <RowMenu r={r} c={c} />
    </div>
  );
}

/** "today 21:25", "tomorrow 09:00", "Nov 20, 09:00" (the year when it is not this one). */
function when(iso: string, zone: string, now: number): string {
  const k = dayKey(iso, zone);
  if (k === dayKey(new Date(now).toISOString(), zone)) return `today ${hm(iso, zone)}`;
  if (k === dayKey(new Date(now + DAY_MS).toISOString(), zone)) return `tomorrow ${hm(iso, zone)}`;
  return `${date(iso, zone, now)}, ${hm(iso, zone)}`;
}
/** "Nov 16", or "Aug 2, 2025" in another year. */
function date(iso: string, zone: string, now: number): string {
  const sameYear = fmt(iso, zone, { year: "numeric" }) === fmt(now, zone, { year: "numeric" });
  return new Intl.DateTimeFormat("en-US", { timeZone: zone, month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) }).format(new Date(iso));
}
function span(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  if (d >= 2) return `${d} days`;
  if (d === 1) return h ? `1 day ${h}h` : "1 day";
  if (h) return `${h}h ${m % 60}m`;
  return `${m}m`;
}

function Window({ r, zone, now }: { r: GrantRowJSON; zone: string; now: number }) {
  let icon = "∞", tone = "warn", main: string, sub: string | null = null, pct: number | null = null;
  const startIso = r.startsAt ?? r.createdAt;
  if (r.state === "ended") {
    icon = "–"; tone = "muted";
    const verb = r.reason === "revoked" ? "Revoked" : r.reason === "denied" ? "Denied" : "Ended";
    main = r.endedAt ? `${verb} ${date(r.endedAt, zone, now)}` : verb;
    sub = r.reason === "denied" ? r.denyReason || "request declined"
      : r.reason === "expired" && r.endsAt ? `lasted ${span(Date.parse(r.endsAt) - Date.parse(startIso))}`
        : `granted ${date(r.createdAt, zone, now)}`;
  } else if (r.kind === "recurring") {
    icon = "↻"; tone = "violet";
    main = `${r.days} · ${r.hours}`;
    // The hours are wall times in the schedule's own zone; so is its next opening.
    const next = r.state === "active" ? "open now" : r.reason === "not_yet" && r.startsAt ? `starts ${when(r.startsAt, zone, now)}` : r.nextStart ? `next: ${when(r.nextStart, r.zone ?? zone, now)}` : "no upcoming hours";
    sub = r.endsAt ? `${next} · until ${date(r.endsAt, zone, now)}` : next;
  } else if (r.kind === "timed" && r.endsAt) {
    icon = "◷"; tone = "p";
    const end = Date.parse(r.endsAt);
    if (r.state === "scheduled" && r.startsAt) {
      main = `Starts ${when(r.startsAt, zone, now)}`;
      sub = `for ${span(end - Date.parse(r.startsAt))}`;
    } else {
      main = `${span(end - now)} left`;
      sub = `ends ${when(r.endsAt, zone, now)}`;
      const total = end - Date.parse(startIso);
      pct = total > 0 ? Math.min(100, Math.max(0, ((now - Date.parse(startIso)) / total) * 100)) : 100;
    }
  } else {
    main = "Permanent";
    sub = r.state === "scheduled" && r.startsAt ? `starts ${when(r.startsAt, zone, now)}` : `${r.startsAt ? "Started" : "Started immediately"} · ${date(startIso, zone, now)}`;
  }
  return (
    <span className="gr-win">
      <span className="gr-win-m" title={r.zone ?? undefined}><span className={`gr-win-ic ${tone}`} aria-hidden="true">{icon}</span>{main}</span>
      {pct !== null && <span className="gr-bar" aria-hidden="true"><span style={{ width: `${pct}%` }} /></span>}
      {sub && <span className="gr-win-s">{sub}</span>}
    </span>
  );
}

function RowMenu({ r, c }: { r: GrantRowJSON; c: RowCtx }) {
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = () => { setOpen(false); setConfirm(false); };
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) close(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey); };
  }, [open]);

  const live = r.state === "active" || r.state === "scheduled";
  // REVOKED and DENIED grants are closed for good; an expired one can still be renewed.
  const editable = c.canConfigure && r.reason !== "revoked" && r.reason !== "denied";
  const run = async (f: () => Promise<void>) => { setBusy(true); await f(); setBusy(false); setOpen(false); setConfirm(false); };

  let quick: { label: string; go: () => void } | null = null;
  if (editable && live && r.permanent) {
    quick = { label: `Add end date (${c.limit} days)`, go: () => void run(() => c.onPatch(r, new Date(Date.now() + c.limit * DAY_MS), `Grant now ends in ${c.limit} days`)) };
  } else if (editable && live && r.endsAt) {
    quick = { label: "Extend by 1 day", go: () => void run(() => c.onPatch(r, new Date(Date.parse(r.endsAt!) + DAY_MS), "Grant extended by 1 day")) };
  } else if (editable && r.reason === "expired") {
    quick = { label: "Renew (1 day)", go: () => void run(() => c.onPatch(r, new Date(Date.now() + DAY_MS), "Grant renewed for 1 day")) };
  } else if (c.canApprove && (r.reason === "revoked" || r.reason === "denied")) {
    quick = { label: "Grant again…", go: () => { setOpen(false); c.onGrantAgain(r); } };
  }
  const items = editable || quick || (c.canApprove && live);
  if (!items) return <span />;

  return (
    <div className="rs-menu gr-menu" ref={ref}>
      <button type="button" className="btn sm rs-more" aria-label="Grant actions" aria-expanded={open} onClick={() => { setOpen((v) => !v); setConfirm(false); }}>⋯</button>
      {open && (
        <div className="rs-menu-pop" role="menu">
          {editable && <button type="button" role="menuitem" className="rs-mi" onClick={() => { setOpen(false); c.onEdit(r); }}>Edit</button>}
          {quick && <button type="button" role="menuitem" className="rs-mi" disabled={busy} onClick={quick.go}>{quick.label}</button>}
          {c.canApprove && live && (
            <>
              <hr />
              {confirm ? (
                <button type="button" role="menuitem" className="rs-mi danger-solid" disabled={busy} onClick={() => void run(() => c.onRevoke(r))}>{busy ? "Revoking…" : "Sure? Revoke"}</button>
              ) : (
                <button type="button" role="menuitem" className="rs-mi danger" onClick={() => setConfirm(true)}>Revoke access</button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

const shortDate = (iso: string) => new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));
