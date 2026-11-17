"use client";
import Link from "next/link";
import { useEffect, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import type { ConsoleData, LiveCard } from "@/lib/console/data";
import type { ActivityCategory } from "@/lib/console/activity-feed";
import { expiresIn } from "@/lib/console/format";
import { DecisionButtons } from "@/app/(app)/admin/grants/decision-buttons";
import { ExtendButton } from "./extend-button";
import { RevokeAccessButton } from "./revoke-access-button";
import { AutoRefresh } from "@/app/(app)/_shell/auto-refresh";
import { LocalTime } from "@/app/(app)/_shell/local-time";
import { NavIcon } from "@/app/(app)/_shell/nav-icons";

/**
 * The console home of the design hand-off: an alert when a connector is out of
 * date, the KPI strip, live sessions, pending / expiring / connectors, and the
 * audit stream. Zero values stay neutral; colour is for states that mean
 * something.
 */
export function ConsoleHome({ data }: { data: ConsoleData }) {
  const { kpis, live, pending, expiring, connectors, audit } = data;
  const now = useNow(30_000);
  const outdated = connectors.filter((c) => c.outdated);
  const [toast, setToast] = useState<string | null>(null);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2600);
    return () => clearTimeout(t);
  }, [toast]);

  const recordedPct = kpis.sessions7d > 0 ? Math.min(100, Math.round((kpis.recordings7d / kpis.sessions7d) * 100)) : null;
  const longest = kpis.longestLiveSince ? minutesSince(kpis.longestLiveSince, now) : null;

  return (
    <div className="cx">
      <AutoRefresh />
      {outdated.length > 0 && <OutdatedAlert names={outdated.map((c) => `${c.name} runs v${c.version}`)} version={data.managerVersion} />}

      <div className="kstrip" role="list">
        <Kpi label="Active grants" value={kpis.grants} href="/admin/grants"
          sub={kpis.grantsThisWeek > 0 ? <span className="t-ok">+{kpis.grantsThisWeek} this week</span> : null} />
        <Kpi label="Live" value={kpis.live} href="/admin/live" tone={kpis.live > 0 ? "ok" : undefined}
          sub={longest !== null ? `longest ${fmtMinutes(longest)}` : "none"} />
        <Kpi label="Pending" value={kpis.pending} href="/admin/grants" tone={kpis.pending > 0 ? "warn" : undefined}
          sub={kpis.pending > 0 ? "awaiting a decision" : "none"} />
        <Kpi label="Expiring 24h" value={kpis.expiring24h} href="/admin/grants" tone={kpis.expiring24h > 0 ? "warn" : undefined}
          sub={kpis.expiring24h > 0 ? "grants ending soon" : "none"} />
        <Kpi label="Recordings · 7d" value={kpis.recordings7d} href="/admin/recordings"
          sub={recordedPct !== null ? `${recordedPct}% recorded` : null} />
      </div>

      <section className="card cx-live">
        <div className="card-head">
          <div className="cx-title">
            <span className={live.length > 0 ? "cx-dot on" : "cx-dot"} aria-hidden="true" />
            <h2>Live sessions</h2>
            <span className="count">{live.length}</span>
          </div>
          <Link href="/admin/live" className="card-link">All sessions →</Link>
        </div>
        {live.length === 0 ? (
          <Empty icon="activity" title="No live sessions" text="Sessions in progress show up here with Watch live and Terminate." />
        ) : (
          <div className="cx-live-list">
            {live.map((s) => <LiveRow key={liveKey(s)} s={s} onDone={setToast} />)}
          </div>
        )}
      </section>

      <div className="cx-three">
        <section className="card">
          <div className="card-head">
            <h2>Pending requests</h2>
            <span className="count">{pending.length}</span>
          </div>
          {pending.length === 0 ? (
            <Empty icon="inbox" title="Nothing waiting" text="New access requests show up here and in notifications." />
          ) : (
            <div className="cx-rows">
              {pending.map((p) => (
                <div key={p.id} className="cx-req">
                  <div className="cx-req-t"><b>{p.userLabel}</b> → {p.siteName}</div>
                  {p.detail && <div className="cx-req-d">{p.detail}</div>}
                  <DecisionButtons grantId={p.id} />
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="card">
          <div className="card-head">
            <h2>Expiring soon</h2>
            <span className="count">24H</span>
          </div>
          {expiring.length === 0 ? (
            <Empty icon="clock" title="Nothing expiring" text="Grants ending in the next 24 hours are listed here." />
          ) : (
            <div className="cx-rows">
              {expiring.map((e) => (
                <div key={e.id} className="cx-exp">
                  <div className="cx-exp-main">
                    <Link href="/admin/grants" className="cx-exp-t"><b>{e.userLabel}</b> → {e.siteName}</Link>
                    <span className="cx-exp-left">{expiresIn(e.endsAt, now)} left</span>
                  </div>
                  <ExtendButton grantId={e.id} endsAt={e.endsAt} />
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="card">
          <div className="card-head">
            <h2>Connectors</h2>
            <Link href="/admin/connectors" className="card-link">Manage →</Link>
          </div>
          {connectors.length === 0 ? (
            <Empty icon="plug" title="No connectors" text="Add a connector inside your network to reach resources." />
          ) : (
            <div className="cx-rows">
              {connectors.map((c) => (
                <Link key={c.id} href={`/admin/connectors/${c.id}`} className="cx-conn">
                  <span className={c.online ? "cx-conn-ic ok" : "cx-conn-ic"}><NavIcon name="plug" size={16} /></span>
                  <span className="cx-conn-main">
                    <b>{c.name}</b>
                    <span className="mono">
                      {c.version ? `v${c.version}` : "version unknown"}
                      {c.lastSeenAt && <> · seen {agoShort(c.lastSeenAt, now)}</>}
                    </span>
                  </span>
                  <span className="cx-conn-state">
                    <span className={c.online ? "t-ok" : "t-muted"}><span className="cx-sdot" aria-hidden="true" />{c.online ? "Online" : "Offline"}</span>
                    {c.outdated && <span className="mono t-warn">v{data.managerVersion} available</span>}
                  </span>
                </Link>
              ))}
            </div>
          )}
        </section>
      </div>

      <AuditStream rows={audit} />
      {toast && <div className="toast" role="status"><span aria-hidden="true">✓</span> {toast}</div>}
    </div>
  );
}

function Kpi({ label, value, sub, tone, href }: { label: string; value: number; sub?: React.ReactNode; tone?: "ok" | "warn"; href: string }) {
  return (
    <Link href={href} className="kcell" role="listitem">
      <span className="kcell-k">{label}</span>
      <span className="kcell-row">
        <span className={tone ? `kcell-v t-${tone}` : "kcell-v"}>{value}</span>
        {sub ? <span className="kcell-s">{sub}</span> : null}
      </span>
    </Link>
  );
}

function OutdatedAlert({ names, version }: { names: string[]; version: string }) {
  // Dismissed per manager version: the next release brings it back.
  const key = `ca-alert-connectors-${version}`;
  const dismissed = useSyncExternalStore(
    subscribeStorage,
    () => { try { return localStorage.getItem(key) === "1"; } catch { return false; } },
    () => false,
  );
  if (dismissed) return null;
  return (
    <div className="alert-banner" role="alert">
      <span className="alert-ic" aria-hidden="true">!</span>
      <span className="alert-text">
        <b>{names.length} connector{names.length === 1 ? " is" : "s are"} out of date.</b>{" "}
        {names.join("; ")}; this console is v{version}. Updating needs no downtime.
      </span>
      <Link href="/admin/connectors" className="btn sm">Review →</Link>
      <button
        type="button"
        className="alert-x"
        aria-label="Dismiss"
        onClick={() => { try { localStorage.setItem(key, "1"); } catch { /* ignore */ } window.dispatchEvent(new Event("storage")); }}
      >
        ×
      </button>
    </div>
  );
}

function LiveRow({ s, onDone }: { s: LiveCard; onDone: (msg: string) => void }) {
  const kind = s.kind === "gateway" ? s.protocol.toUpperCase() : s.kind === "isolated" ? "ISOLATED" : "WEB";
  const name = s.siteName;
  const recorded = s.kind !== "web" && s.recorded;
  const watch = s.kind === "web" ? (s.liveKey ? `/live/web/${encodeURIComponent(s.liveKey)}` : null) : `/live/${s.sessionId}`;
  return (
    <div className="cx-live-row">
      <div className="cx-thumb" aria-hidden="true">
        {recorded && <span className="cx-rec">● REC</span>}
        <span className="cx-thumb-l">live preview</span>
      </div>
      <div className="cx-live-main">
        <div className="cx-live-t">
          <span className={s.kind === "web" ? "chip" : "chip violet"}>{kind}</span>
          <b>{name}</b>
          <span className="mono t-muted">{s.host}</span>
        </div>
        <div className="cx-live-s">
          <span>{s.userLabel}</span>
          <span>started <LocalTime iso={s.startedAt} mode="time" /></span>
          <Elapsed since={s.startedAt} />
          {s.viewerCount > 0 && <span>{s.viewerCount} watching</span>}
        </div>
      </div>
      <div className="cx-live-actions">
        {watch && <Link href={watch} className="btn primary sm">Watch live</Link>}
        {s.kind === "web" ? (
          s.grantId ? <RevokeAccessButton grantId={s.grantId} label={s.userLabel} className="btn danger sm" /> : null
        ) : (
          <InlineTerminate sessionId={s.sessionId} grantId={s.grantId} onDone={onDone} />
        )}
      </div>
    </div>
  );
}

/** Terminate with the confirmation in place of the button, as the design asks. */
function InlineTerminate({ sessionId, grantId, onDone }: { sessionId: string; grantId: string | null; onDone: (msg: string) => void }) {
  const [ask, setAsk] = useState(false);
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  if (!ask) return <button type="button" className="btn danger sm" onClick={() => setAsk(true)}>Terminate</button>;
  return (
    <span className="cx-confirm" role="group" aria-label="Confirm termination">
      <span>{grantId ? "End the session and revoke this access?" : "End the session now?"}</span>
      <button
        type="button"
        className="btn danger sm"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await fetch(`/api/admin/live/${sessionId}/terminate`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(grantId ? { grantId } : {}),
            });
            onDone(grantId ? "Session terminated and access revoked" : "Session terminated");
          } catch {
            /* the refresh shows what happened */
          }
          router.refresh();
        }}
      >
        {busy ? "Terminating…" : "Yes, terminate"}
      </button>
      <button type="button" className="btn ghost sm" disabled={busy} onClick={() => setAsk(false)}>Cancel</button>
    </span>
  );
}

const FILTERS: { key: "all" | ActivityCategory; label: string }[] = [
  { key: "all", label: "All" },
  { key: "session", label: "Session" },
  { key: "recording", label: "Recording" },
  { key: "policy", label: "Policy" },
];

function AuditStream({ rows }: { rows: ConsoleData["audit"] }) {
  const [f, setF] = useState<"all" | ActivityCategory>("all");
  const shown = rows.filter((r) => f === "all" || r.category === f);
  return (
    <section className="card cx-audit">
      <div className="card-head">
        <h2>Audit stream</h2>
        <div className="cx-audit-tools">
          <div className="filter-pills" role="group" aria-label="Filter">
            {FILTERS.map((x) => (
              <button key={x.key} type="button" className={f === x.key ? "fpill on" : "fpill"} aria-pressed={f === x.key} onClick={() => setF(x.key)}>
                {x.label}
              </button>
            ))}
          </div>
          <Link href="/admin/audit" className="card-link">Open audit →</Link>
        </div>
      </div>
      {shown.length === 0 ? (
        <Empty icon="list" title="No recent activity" text="Sessions, recordings and policy changes show up here as they happen." />
      ) : (
        <div className="cx-audit-rows">
          {shown.map((r) => (
            <div key={r.id} className="cx-audit-row">
              <span className="mono t-muted"><LocalTime iso={new Date(r.at).toISOString()} mode="time" /></span>
              <span><span className={`evt ${r.tone === "deny" ? "bad" : r.category}`}>{r.kind}</span></span>
              <span className="cx-audit-m">{r.text}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

export function Empty({ icon, title, text, ok }: { icon: Parameters<typeof NavIcon>[0]["name"]; title: string; text: string; ok?: boolean }) {
  return (
    <div className="empty-state">
      <span className={ok ? "es-ic ok" : "es-ic"}><NavIcon name={icon} /></span>
      <b>{title}</b>
      <span>{text}</span>
    </div>
  );
}

/** mm:ss (or h:mm:ss) since a start, ticking every second. */
function Elapsed({ since }: { since: string }) {
  const now = useNow(1000);
  const secs = Math.max(0, Math.floor((now.getTime() - new Date(since).getTime()) / 1000));
  const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60), sec = secs % 60;
  const text = h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
  return <span className="mono cx-elapsed">{text}</span>;
}

function useNow(everyMs: number): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return now;
}

function subscribeStorage(cb: () => void) {
  window.addEventListener("storage", cb);
  return () => window.removeEventListener("storage", cb);
}

function liveKey(s: LiveCard): string {
  return s.kind === "web" ? `web:${s.userLabel}:${s.siteName}:${s.host}` : s.sessionId;
}
function minutesSince(iso: string, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - new Date(iso).getTime()) / 60000));
}
function fmtMinutes(m: number): string {
  return m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m` : `${m}m`;
}
function agoShort(iso: string, now: Date): string {
  const s = Math.max(0, Math.floor((now.getTime() - new Date(iso).getTime()) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
