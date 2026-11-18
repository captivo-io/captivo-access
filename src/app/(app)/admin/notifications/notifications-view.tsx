"use client";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ResourceIcon } from "@/components/resource-icon";
import type { SiteTile } from "@/lib/access/grant-rows";
import { durationLabel, incidentStats, stripSegment, type Incident } from "@/lib/notifications/incidents";
import { dayKey, dayLabel, fmt, hm, useZone } from "../audit/audit-zone";

type Filter = "all" | "open" | "done";

/**
 * Notifications, as the design hand-off (README 7.22) lays them out: every
 * down and its recovery are one incident, grouped by day, with a 48-hour strip.
 */
export function NotificationsView({ incidents, tiles, unreachable, workspace, canTest, serverNow }: {
  incidents: Incident[];
  tiles: Record<string, SiteTile>;
  unreachable: number;
  workspace: string | null;
  canTest: boolean;
  /** Times are relative to this until the page is mounted, so both renders agree. */
  serverNow: number;
}) {
  const router = useRouter();
  const zone = useZone();
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [unreadOnly, setUnreadOnly] = useState(false);
  // Marked read here, before the server catches up.
  const [readHere, setReadHere] = useState<Set<string>>(() => new Set());
  const [allRead, setAllRead] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
  const now = serverNow;
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3200);
    return () => clearTimeout(t);
  }, [toast]);

  const isRead = (i: Incident) => allRead || i.read || readHere.has(i.id);
  const openN = incidents.filter((i) => i.upAt === null).length;
  const unreadN = incidents.filter((i) => !isRead(i)).length;
  const stats = useMemo(() => incidentStats(incidents, now), [incidents, now]);

  const t = q.trim().toLowerCase();
  const shown = incidents.filter((i) =>
    (filter === "all" || (filter === "open" ? i.upAt === null : i.upAt !== null))
    && (!unreadOnly || !isRead(i))
    && (!t || `${i.siteName} ${i.reason ?? ""}`.toLowerCase().includes(t)));

  const today = dayKey(new Date(now).toISOString(), zone);
  const yesterday = dayKey(new Date(now - 24 * 3600_000).toISOString(), zone);
  const days: { key: string; label: string; rows: Incident[] }[] = [];
  for (const i of shown) {
    const at = i.downAt ?? i.upAt!;
    const key = dayKey(at, zone);
    const last = days[days.length - 1];
    if (last && last.key === key) last.rows.push(i);
    else {
      const base = dayLabel(at, zone).split(" · ")[1];
      days.push({ key, label: key === today ? `TODAY · ${base}` : key === yesterday ? `YESTERDAY · ${base}` : dayLabel(at, zone), rows: [i] });
    }
  }

  async function markRead(i: Incident) {
    if (isRead(i)) return;
    setReadHere((s) => new Set(s).add(i.id));
    await fetch("/api/admin/notifications/read", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids: i.rowIds }) }).catch(() => {});
    router.refresh();
  }
  async function markAll() {
    setAllRead(true);
    await fetch("/api/admin/notifications/read", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ all: true }) }).catch(() => {});
    setToast({ msg: "All notifications marked as read", ok: true });
    router.refresh();
  }
  async function test(i: Incident) {
    if (!i.siteId) return;
    setTesting(i.id);
    let ok = false;
    try {
      const res = await fetch(`/api/admin/sites/${encodeURIComponent(i.siteId)}/test`, { method: "POST" });
      const b = (await res.json().catch(() => ({}))) as { ok?: boolean; status?: number; error?: string };
      ok = res.ok && (b.ok === true || typeof b.status === "number");
      setToast(ok ? { msg: `${i.siteName} is reachable again`, ok: true } : { msg: `${i.siteName} is still unreachable${b.error ? ` · ${b.error}` : ""}`, ok: false });
    } catch {
      setToast({ msg: `${i.siteName} is still unreachable`, ok: false });
    } finally {
      setTesting(null);
      router.refresh();
    }
  }

  const upTime = (i: Incident) => {
    if (!i.upAt) return "ongoing";
    const sameDay = !i.downAt || dayKey(i.upAt, zone) === dayKey(i.downAt, zone);
    return sameDay ? hm(i.upAt, zone) : `${fmt(i.upAt, zone, { month: "short", day: "numeric" })} ${hm(i.upAt, zone)}`;
  };

  return (
    <div className="nf">
      <div className="page-head">
        <div>
          <div className="eyebrow">Platform{workspace ? ` · ${workspace}` : ""}</div>
          <h1>Notifications</h1>
          <p>Outages found by the health check. Each down and its recovery are merged into one incident.</p>
        </div>
        <div className="row-actions">
          <Link href="/admin/policy#notifications" className="btn">Notification rules</Link>
          <button type="button" className="btn primary" disabled={unreadN === 0} onClick={() => void markAll()}>Mark all as read</button>
        </div>
      </div>

      <div className="kstrip nf-kpis">
        <div className="kcell">
          <span className="kcell-k"><span className={unreachable ? "rs-kdot bad nf-pulse" : "rs-kdot ok"} />Down right now</span>
          <span className="kcell-row"><span className="kcell-v">{unreachable}</span><span className="kcell-s">{unreachable ? (unreachable === 1 ? "resource" : "resources") : "all healthy"}</span></span>
        </div>
        <div className="kcell">
          <span className="kcell-k"><span className="rs-kdot warn" />Last 24 hours</span>
          <span className="kcell-row"><span className="kcell-v">{stats.last24h}</span><span className="kcell-s">{stats.last24h === 1 ? "incident" : "incidents"}</span></span>
        </div>
        <div className="kcell">
          <span className="kcell-k"><span className="rs-kdot p" />Avg. outage</span>
          <span className="kcell-row"><span className="kcell-v">{stats.mttrMs === null ? "—" : durationLabel(stats.mttrMs)}</span><span className="kcell-s">time to recover</span></span>
        </div>
      </div>

      <div className="nf-tools">
        <label className="ma-search nf-search">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search resource or reason…" aria-label="Search resource or reason" />
        </label>
        <div className="seg" role="radiogroup" aria-label="Status">
          {([["all", "All", incidents.length], ["open", "Ongoing", openN], ["done", "Resolved", incidents.length - openN]] as const).map(([k, label, n]) => (
            <button key={k} type="button" role="radio" aria-checked={filter === k} className={filter === k ? "seg-opt on" : "seg-opt"} onClick={() => setFilter(k)}>
              {label}<span className={k === "open" && n ? "nf-n bad" : "nf-n"}>{n}</span>
            </button>
          ))}
        </div>
        <button type="button" className={unreadOnly ? "fpill on nf-unread" : "fpill nf-unread"} aria-pressed={unreadOnly} onClick={() => setUnreadOnly((v) => !v)}>
          <span className="nf-udot" aria-hidden="true" />Unread<span className="nf-n">{unreadN}</span>
        </button>
      </div>

      {days.map((d) => (
        <section key={d.key} className="nf-day">
          <div className="nf-day-h"><span>{d.label}</span><span>{d.rows.length} {d.rows.length === 1 ? "incident" : "incidents"}</span></div>
          {d.rows.map((i) => {
            const open = i.upAt === null;
            const unread = !isRead(i);
            const tile = i.siteId ? tiles[i.siteId] : undefined;
            const seg = stripSegment(i, now);
            const durMs = i.downAt ? (i.upAt ? new Date(i.upAt).getTime() : now) - new Date(i.downAt).getTime() : null;
            return (
              <div key={i.id} className={unread ? "nf-row unread" : "nf-row"} onClick={() => void markRead(i)}>
                {unread && <span className="nf-dot" aria-label="Unread" />}
                <span className="nf-main">
                  {tile ? <ResourceIcon name={tile.icon} color={tile.color} logoUrl={tile.logoUrl} logoBg={tile.logoBg} size={38} /> : <ResourceIcon name="server" color="slate" size={38} />}
                  <span className="nf-txt">
                    <span className="nf-l1">
                      <span className="nf-name">{i.siteName}</span>
                      <span className={open ? "nf-st bad" : "nf-st ok"}><span aria-hidden="true" />{open ? "Down" : "Recovered"}</span>
                      {i.reason && <span className="nf-why" title={i.reason}>{i.reason}</span>}
                    </span>
                    <span className="nf-meta">
                      {i.downAt && <span><b className="bad">↓</b> {hm(i.downAt, zone)}</span>}
                      <span><b className={open ? "" : "ok"}>↑</b> {upTime(i)}</span>
                      {durMs !== null && <span className="nf-dur">{durationLabel(durMs)}</span>}
                    </span>
                  </span>
                </span>
                <span className="nf-strip" title="Last 48 hours · red: outage">
                  <span className="nf-bar">{seg && <span style={{ left: `${seg.left.toFixed(1)}%`, width: `${seg.width.toFixed(1)}%` }} />}</span>
                  <span className="nf-axis"><span>-48 h</span><span>-24 h</span><span>now</span></span>
                </span>
                <span className="nf-acts">
                  {open && canTest && i.siteId && tile && (
                    <button type="button" className="btn sm" disabled={testing === i.id} onClick={(e) => { e.stopPropagation(); void test(i); }}>
                      {testing === i.id && <span className="nf-spin" aria-hidden="true" />}{testing === i.id ? "Testing…" : "Test now"}
                    </button>
                  )}
                  <Link href={`/admin/sites?q=${encodeURIComponent(i.siteName)}`} className="nf-go" onClick={(e) => e.stopPropagation()}>Go to resource →</Link>
                </span>
              </div>
            );
          })}
        </section>
      ))}

      {days.length === 0 && (
        incidents.length === 0 ? (
          <div className="au-empty"><b>No outages yet</b><span className="cell-sub">When the health check can&apos;t reach a resource, the incident shows up here.</span></div>
        ) : (
          <div className="nf-empty">
            <span>No incidents match these filters.</span>
            <button type="button" className="btn sm" onClick={() => { setQ(""); setFilter("all"); setUnreadOnly(false); }}>Clear filters</button>
          </div>
        )
      )}

      <p className="nf-note">The health check tries each resource every 5 minutes; one failed check opens an incident and the next successful one closes it. Incidents are kept until they are deleted.</p>

      {toast && <div className={toast.ok ? "toast" : "toast warn"} role="status"><span aria-hidden="true">{toast.ok ? "✓" : "!"}</span> {toast.msg}</div>}
    </div>
  );
}
