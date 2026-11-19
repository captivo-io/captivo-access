"use client";
import { useMemo, useState } from "react";
import { ResourceIcon } from "@/components/resource-icon";
import type { IconColor } from "@/lib/site/icons";
import type { HistoryWindow } from "@/lib/portal/history";
import { durationText, matches, summarize, type HistoryKind, type HistoryRowJSON } from "@/lib/portal/history-view";
import { dayKey, dayLabel, hm, useZone } from "@/app/(app)/admin/audit/audit-zone";

type Kind = "all" | HistoryKind;

const VIA = { isolated: "Isolated browser", gateway: "Gateway" } as const;

/**
 * Session history as the design hand-off (README 7.21) lays it out: a week of
 * KPIs, then one card per day with a duration bar per session.
 */
export function HistoryView({ initial, retentionDays, workspace, serverNow }: {
  initial: HistoryWindow;
  /** 0 = recordings are kept until an admin deletes them. */
  retentionDays: number;
  workspace: string | null;
  /** Day labels are relative to this, so the server and client renders agree. */
  serverNow: number;
}) {
  const zone = useZone();
  const [rows, setRows] = useState<HistoryRowJSON[]>(initial.rows);
  const [from, setFrom] = useState(initial.from);
  const [more, setMore] = useState(initial.more);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<Kind>("all");

  // The KPIs always describe the first week, whatever else has been loaded.
  const week = useMemo(() => summarize(initial.rows), [initial.rows]);
  const longest = useMemo(() => Math.max(1, ...rows.map((r) => r.durationMs)), [rows]);
  const shown = rows.filter((r) => matches(r, q, kind));
  const counts = { all: rows.length, web: rows.filter((r) => r.kind === "web").length, remote: rows.filter((r) => r.kind === "remote").length };

  const today = dayKey(new Date(serverNow).toISOString(), zone);
  const yesterday = dayKey(new Date(serverNow - 86_400_000).toISOString(), zone);
  const days: { key: string; label: string; rows: HistoryRowJSON[] }[] = [];
  for (const r of shown) {
    const key = dayKey(r.startedAt, zone);
    const last = days[days.length - 1];
    if (last && last.key === key) last.rows.push(r);
    else {
      const base = dayLabel(r.startedAt, zone).split(" · ")[1];
      days.push({ key, label: key === today ? `TODAY · ${base}` : key === yesterday ? `YESTERDAY · ${base}` : dayLabel(r.startedAt, zone), rows: [r] });
    }
  }

  async function loadEarlier() {
    setBusy(true);
    setFailed(false);
    try {
      const res = await fetch(`/api/portal/history?until=${encodeURIComponent(from)}`);
      if (!res.ok) throw new Error(String(res.status));
      const next = (await res.json()) as HistoryWindow;
      setRows((r) => [...r, ...next.rows]);
      setFrom(next.from);
      setMore(next.more);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  const range = (r: HistoryRowJSON) => `${hm(r.startedAt, zone)}–${hm(r.endedAt, zone)}`;
  const keep = retentionDays > 0
    ? `History is kept for ${retentionDays} days.`
    : "History is kept until an admin deletes the session's recording.";

  return (
    <div className="hs">
      <div className="page-head">
        <div>
          <div className="eyebrow">My access{workspace ? ` · ${workspace}` : ""}</div>
          <h1>Session history</h1>
          <p>The remote sessions you opened, when, and for how long.</p>
        </div>
      </div>

      <div className="kstrip hs-kpis">
        <div className="kcell">
          <span className="kcell-k"><span className="rs-kdot p" />Last 7 days</span>
          <span className="kcell-row"><span className="kcell-v">{week.count}</span><span className="kcell-s">{week.count === 1 ? "session" : "sessions"}</span></span>
        </div>
        <div className="kcell">
          <span className="kcell-k"><span className="rs-kdot ok" />Total time</span>
          <span className="kcell-row"><span className="kcell-v">{week.count ? durationText(week.totalMs) : "—"}</span><span className="kcell-s">active use</span></span>
        </div>
        <div className="kcell">
          <span className="kcell-k"><span className="rs-kdot violet" />Most used</span>
          <span className="kcell-row">
            <span className="kcell-v hs-top" title={week.top?.name}>{week.top?.name ?? "—"}</span>
            {week.top && <span className="kcell-s">{week.top.count} {week.top.count === 1 ? "session" : "sessions"}</span>}
          </span>
        </div>
      </div>

      <div className="nf-tools">
        <label className="ma-search nf-search">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search resources…" aria-label="Search resources" />
        </label>
        <div className="seg" role="radiogroup" aria-label="Kind">
          {([["all", "All"], ["web", "Web"], ["remote", "Remote"]] as const).map(([k, label]) => (
            <button key={k} type="button" role="radio" aria-checked={kind === k} className={kind === k ? "seg-opt on" : "seg-opt"} onClick={() => setKind(k)}>
              {label}<span className="nf-n">{counts[k]}</span>
            </button>
          ))}
        </div>
      </div>

      {days.map((d) => (
        <section key={d.key} className="nf-day">
          <div className="nf-day-h">
            <span>{d.label}</span>
            <span>{d.rows.length} {d.rows.length === 1 ? "session" : "sessions"} · {durationText(d.rows.reduce((a, r) => a + r.durationMs, 0))}</span>
          </div>
          {d.rows.map((r) => (
            <div key={r.id} className="hs-row">
              <span className="hs-time">{range(r)}</span>
              <span className="hs-main">
                {r.tile
                  ? <ResourceIcon name={r.tile.icon} color={r.tile.color as IconColor} logoUrl={r.tile.logoUrl} logoBg={r.tile.logoBg} size={34} />
                  : <ResourceIcon name={r.kind === "web" ? "globe" : "server"} color="slate" size={34} />}
                <span className="hs-txt">
                  <span className="hs-name" title={r.name}>{r.name}</span>
                  <span className="hs-sub"><b>{r.proto}</b>{r.via && <span>· {VIA[r.via]}</span>}{!r.siteId && <span>· deleted</span>}</span>
                </span>
              </span>
              <span className="hs-bar" aria-hidden="true">
                <span className={r.kind === "web" ? "web" : "remote"} style={{ width: `${Math.max(2, Math.round((r.durationMs / longest) * 100))}%` }} />
              </span>
              <span className={r.durationMs < 60_000 ? "hs-dur short" : "hs-dur"}>{durationText(r.durationMs)}</span>
              <span className="hs-act">
                {r.href && <a className="btn sm" href={r.href} target="_blank" rel="noopener noreferrer">Open again</a>}
              </span>
            </div>
          ))}
        </section>
      ))}

      {days.length === 0 && (
        rows.length === 0 ? (
          <div className="au-empty">
            <b>{more ? "No sessions in the last 7 days" : "No sessions yet"}</b>
            <span className="cell-sub">Sessions you open from My access show up here once they end.</span>
          </div>
        ) : (
          <div className="nf-empty">
            <span>No sessions match these filters.</span>
            <button type="button" className="btn sm" onClick={() => { setQ(""); setKind("all"); }}>Clear filters</button>
          </div>
        )
      )}

      {more && (
        <div className="hs-more">
          <button type="button" className="btn sm" disabled={busy} onClick={() => void loadEarlier()}>{busy ? "Loading…" : "Show the week before"}</button>
          {failed && <span className="cell-sub">Couldn&apos;t load older sessions. Try again.</span>}
        </div>
      )}

      <p className="nf-note">{keep} Sessions on resources that aren&apos;t recorded don&apos;t appear here. Only admins can watch session recordings.</p>
    </div>
  );
}
