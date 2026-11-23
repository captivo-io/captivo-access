"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { NavIcon } from "@/app/(app)/_shell/nav-icons";
import type { LiveRow } from "@/lib/live/rows";
import { clockOf, initials, protocolLabel } from "@/lib/recording/format";
import { recordingType } from "@/lib/recording/filter";
import { Thumb } from "../recordings/rec-ui";
import { ResourceIcon } from "@/components/resource-icon";
import type { SiteTile } from "@/lib/access/grant-rows";
import { fmt, hm, useZone } from "../audit/audit-zone";

export interface RecentRecording {
  id: string;
  siteName: string;
  userLabel: string;
  startedAt: string;
  lengthMs: number;
  format: string;
  protocol: string | null;
  site?: SiteTile;
}

type FeedEvent = { at: string; type: string; text: string };

const TERMINAL = ["ssh", "telnet"];
const keyOf = (r: LiveRow) => (r.kind === "web" ? `web:${r.liveKey ?? `${r.userId}:${r.siteId}`}` : r.sessionId);
const kindOf = (r: LiveRow): "ssh" | "rdp" | "web" | "sql" => (r.database ? "sql" : r.kind === "gateway" ? (TERMINAL.includes(r.protocol.toLowerCase()) ? "ssh" : "rdp") : "web");
const nativeApp = (r: LiveRow) => (r.kind === "gateway" && r.protocol === "ssh" ? "SSH" : "Remote Desktop");
const labelOf = (r: LiveRow) => (r.database ? (r.kind === "gateway" && r.protocol === "mysql" ? "MYSQL" : r.kind === "gateway" && r.protocol === "mssql" ? "SQL SERVER" : "POSTGRESQL") : r.kind === "gateway" ? (r.native ? `${r.protocol.toUpperCase()} · NATIVE` : r.protocol.toUpperCase()) : r.kind === "isolated" ? "BROWSER" : "WEB");
const hostOf = (r: LiveRow) => (r.kind === "gateway" ? "" : r.host);
const watchSrc = (r: LiveRow) => (r.kind === "web" ? (r.liveKey ? `/live/web/${encodeURIComponent(r.liveKey)}` : null) : r.native && !r.watchable ? null : `/live/${r.sessionId}`);
const sessionIdOf = (r: LiveRow) => (r.kind === "web" ? null : r.sessionId);

/** Seconds ticking on the client only, so the server render and the first client render agree. */
function useNow(): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

const elapsed = (startedAt: string, now: number | null) => (now === null ? "" : clockOf(Math.max(0, now - Date.parse(startedAt))));

function accessOf(r: LiveRow, now: number | null): string {
  if (r.grantScheduled) return "Set hours";
  if (r.grantEndsAt) {
    if (now === null) return "Ends later";
    const left = Date.parse(r.grantEndsAt) - now;
    if (left <= 0) return "Ending";
    const h = Math.floor(left / 3_600_000), m = Math.floor((left % 3_600_000) / 60_000);
    return h ? `${h} h ${m} min left` : `${m} min left`;
  }
  return r.grantId ? "No end date" : "—";
}

/**
 * Live sessions (design hand-off 7.11): what is running now, each with its
 * elapsed time, who is watching and how busy it is; the watch window with the
 * live view, the session's events, a message to the user and terminate.
 */
export function SessionsView({ rows, dayTotal, recent, workspace, canTerminate, canReplay, initialWatch }: {
  rows: LiveRow[];
  dayTotal: number;
  recent: RecentRecording[];
  workspace: string;
  canTerminate: boolean;
  canReplay: boolean;
  initialWatch: string | null;
}) {
  const router = useRouter();
  const now = useNow();
  const [watchKey, setWatchKey] = useState<string | null>(initialWatch);
  const [ended, setEnded] = useState<Set<string>>(new Set());
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2600);
    return () => clearTimeout(t);
  }, [toast]);

  const live = rows.filter((r) => !ended.has(keyOf(r)));
  const people = new Set(live.map((r) => r.userId ?? r.userLabel)).size;
  const watched = live.filter((r) => r.viewerCount > 0).length;
  const recorded = live.filter((r) => r.recording).length;
  const watching = watchKey ? live.find((r) => keyOf(r) === watchKey) ?? null : null;

  const onEnded = useCallback((r: LiveRow, ok: boolean) => {
    if (ok) setEnded((s) => new Set(s).add(keyOf(r)));
    setToast({ msg: ok ? `Session ended: ${r.userLabel} on ${r.siteName}` : "Couldn't end the session. Try again.", ok });
    if (ok) { setWatchKey(null); router.refresh(); }
  }, [router]);

  return (
    <div>
      <div className="page-head">
        <div>
          <div className="eyebrow"><span className="sv-dot" aria-hidden="true" />Live{workspace ? ` · ${workspace}` : ""}</div>
          <h1>Live sessions</h1>
          <p>Remote desktop, SSH and web sessions running now. Watch one, send its user a message, or end it at once.</p>
        </div>
        <div className="row-actions"><span className="sv-pill"><span className="sv-spin" aria-hidden="true" />Live · updates by itself</span></div>
      </div>

      <div className="kstrip sv-kpis">
        <div className="kcell"><span className="kcell-k"><span className="rs-kdot ok" />Active sessions</span><span className="kcell-row"><span className="kcell-v">{live.length}</span><span className="kcell-s">{people} {people === 1 ? "person" : "people"}</span></span></div>
        <div className="kcell"><span className="kcell-k"><span className="rs-kdot violet" />Being watched</span><span className="kcell-row"><span className="kcell-v">{watched}</span><span className="kcell-s">by an admin</span></span></div>
        <div className="kcell"><span className="kcell-k"><span className="rs-kdot bad" />Recording</span><span className="kcell-row"><span className="kcell-v">{recorded}</span><span className="kcell-s">{recorded === 0 ? "—" : recorded === live.length ? "all recorded" : `of ${live.length}`}</span></span></div>
        <div className="kcell"><span className="kcell-k"><span className="rs-kdot p" />Last 24 h</span><span className="kcell-row"><span className="kcell-v">{dayTotal}</span><span className="kcell-s">sessions</span></span></div>
      </div>

      {live.length === 0 ? (
        <div className="sv-empty">
          <span className="sv-empty-ic"><NavIcon name="activity" size={24} /></span>
          <b>No active sessions right now</b>
          <span>When a vendor or admin opens a resource, the session appears here at once. You can watch it, message its user or end it.</span>
          <span className="sv-empty-act">
            {canReplay && <Link href="/admin/recordings" className="btn">See recent recordings</Link>}
            <Link href="/admin/grants?new=1" className="btn primary">+ Grant access</Link>
          </span>
        </div>
      ) : (
        <div className="sv-grid">
          {live.map((r) => (
            <Card key={keyOf(r)} r={r} now={now} watching={watchKey === keyOf(r)} canTerminate={canTerminate}
              onWatch={() => setWatchKey(keyOf(r))} onEnded={onEnded} />
          ))}
        </div>
      )}

      {canReplay && recent.length > 0 && (
        <section className="sv-recent">
          <div className="sv-recent-head"><b>Recently ended</b><Link href="/admin/recordings" className="cn-link">All recordings →</Link></div>
          {recent.map((x) => (
            <Link key={x.id} href={`/admin/recordings/${x.id}`} className="sv-recent-row">
              {x.site ? <ResourceIcon name={x.site.icon} color={x.site.color} logoUrl={x.site.logoUrl} logoBg={x.site.logoBg} size={30} />
                : <ResourceIcon name={recordingType(x) === "rdp" ? "desktop" : recordingType(x) === "ssh" ? "terminal" : "globe"} color={recordingType(x) === "web" ? "blue" : "violet"} size={30} />}
              <span className="sv-recent-t"><b>{x.siteName}</b><span className="cell-sub"><span className="rs-proto-l">{protocolLabel(x)}</span> · {x.userLabel}</span></span>
              <RecentTime iso={x.startedAt} />
              <span className="mono cell-sub">{clockOf(x.lengthMs)}</span>
              <span className="sv-recent-play" aria-hidden="true">▶</span>
            </Link>
          ))}
        </section>
      )}

      {watching && (
        <WatchWindow r={watching} now={now} workspace={workspace} canAct={canTerminate}
          onClose={() => { setWatchKey(null); router.refresh(); }} onEnded={onEnded}
          onToast={(msg, ok = true) => setToast({ msg, ok })} />
      )}
      {watchKey && !watching && initialWatch === watchKey && <WatchGone onClose={() => setWatchKey(null)} />}
      {toast && <div className={toast.ok ? "toast" : "toast warn"} role="status"><span aria-hidden="true">{toast.ok ? "✓" : "!"}</span> {toast.msg}</div>}
    </div>
  );
}

function RecentTime({ iso }: { iso: string }) {
  const zone = useZone();
  return <span className="mono cell-sub">{fmt(iso, zone, { day: "numeric", month: "short" })} {hm(iso, zone)}</span>;
}

function Sparkline({ values }: { values?: number[] }) {
  const v = values && values.length ? values : new Array(24).fill(0);
  const max = Math.max(1, ...v);
  return (
    <span className="sv-spark" aria-label="Input over the last two minutes" role="img">
      {v.map((n, i) => <i key={i} className={i >= v.length - 3 ? "now" : ""} style={{ height: `${Math.max(8, (n / max) * 100)}%`, opacity: n ? 1 : 0.35 }} />)}
    </span>
  );
}

/** An SSH session's last commands, from its live feed (only where keystrokes are logged). */
function useTail(r: LiveRow): string[] {
  const [tail, setTail] = useState<string[]>([]);
  const id = sessionIdOf(r);
  const want = !!id && ((kindOf(r) === "ssh" && !!r.keystrokes) || !!r.database);
  const activity = r.activity?.join(",");
  useEffect(() => {
    if (!want || !id) return;
    let stop = false;
    fetch(`/api/admin/live/${id}/feed`, { cache: "no-store" })
      .then((x) => (x.ok ? x.json() : { events: [] }))
      .then((b: { events?: FeedEvent[] }) => { if (!stop) setTail((b.events ?? []).filter((e) => e.type === "command").slice(0, 5).map((e) => e.text).reverse()); })
      .catch(() => {});
    return () => { stop = true; };
  }, [want, id, activity]);
  return tail;
}

function Card({ r, now, watching, canTerminate, onWatch, onEnded }: {
  r: LiveRow; now: number | null; watching: boolean; canTerminate: boolean;
  onWatch: () => void; onEnded: (r: LiveRow, ok: boolean) => void;
}) {
  const zone = useZone();
  const kind = kindOf(r);
  const tail = useTail(r);
  const src = watchSrc(r);
  return (
    <article className={watching ? "sv-card on" : "sv-card"}>
      <button type="button" className="sv-thumb" onClick={onWatch} disabled={!src} aria-label={src ? `Watch ${r.userLabel} on ${r.siteName}` : r.database ? "A database session has no screen; its latest queries show here" : r.native ? (r.recording ? `This session in the user's own ${nativeApp(r)} app is recorded; it can't be watched live` : `A session in the user's own ${nativeApp(r)} app can't be watched`) : "This web app does not record, so it can't be watched"}>
        {tail.length ? (
          <span className="rc-art ssh sv-term" aria-hidden="true">
            {tail.map((t, i) => <span key={i} className="mono">{r.database ? "›" : "$"} {t}</span>)}
            <span className="mono">{r.database ? "›" : "$"} <i className="sv-caret" /></span>
          </span>
        ) : <Thumb kind={kind} />}
        <span className="sv-live"><i aria-hidden="true" />LIVE · {labelOf(r)}</span>
        <span className="sv-timer mono">{elapsed(r.startedAt, now)}</span>
        {r.viewerCount > 0 && <span className="sv-watchers"><NavIcon name="users" size={13} />{r.viewerCount} watching</span>}
      </button>
      <div className="sv-body">
        <div className="sv-who">
          <span className="au-av" aria-hidden="true">{initials(r.userLabel)}</span>
          <span className="au-stack">
            <b>{r.userLabel} <span className="sv-arrow">→</span> {r.site && <ResourceIcon name={r.site.icon} color={r.site.color} logoUrl={r.site.logoUrl} logoBg={r.site.logoBg} size={20} className="sv-site-ic" />}{r.siteName}</b>
            <span className="mono cell-sub">{[r.clientIp, hostOf(r), r.via ? `via ${r.via}` : null].filter(Boolean).join(" · ") || "—"}</span>
          </span>
        </div>
        <div className="sv-line">
          <span className="cell-sub">Started {hm(r.startedAt, zone)}</span>
          {r.database ? <><Sparkline values={r.activity} /><span className="cell-sub">{r.recording ? "Queries logged" : "Queries not logged"}</span></> : r.kind !== "web" && !r.native ? <Sparkline values={r.activity} /> : r.native && r.recording ? <><Sparkline values={r.activity} /><span className="cell-sub">Own {nativeApp(r)} app · recorded</span></> : r.native ? <span className="cell-sub">Own {nativeApp(r)} app · not recorded</span> : null}
        </div>
        <Actions r={r} canTerminate={canTerminate} onWatch={src ? onWatch : undefined} onEnded={onEnded} />
      </div>
    </article>
  );
}

async function endSession(r: LiveRow): Promise<boolean> {
  try {
    if (r.kind === "web") {
      if (!r.grantId) return false;
      const res = await fetch(`/api/admin/grants?id=${encodeURIComponent(r.grantId)}`, { method: "DELETE" });
      return res.ok;
    }
    const res = await fetch(`/api/admin/live/${r.sessionId}/terminate`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(r.grantId ? { grantId: r.grantId } : {}),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function confirmText(r: LiveRow): string {
  if (r.kind === "web") return "Revoke access now? The app closes on their next request.";
  return r.grantId ? "End the session now? Their access to this resource is revoked too." : "End the session now?";
}

function Actions({ r, canTerminate, onWatch, onEnded, block }: {
  r: LiveRow; canTerminate: boolean; onWatch?: () => void; onEnded: (r: LiveRow, ok: boolean) => void; block?: boolean;
}) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const canEnd = canTerminate && (r.kind !== "web" || !!r.grantId);
  async function end() {
    setBusy(true);
    const ok = await endSession(r);
    setBusy(false);
    setConfirm(false);
    onEnded(r, ok);
  }
  if (confirm) {
    return (
      <div className={block ? "sv-confirm block" : "sv-confirm"}>
        <span>{confirmText(r)}</span>
        <span className="sv-confirm-b">
          <button type="button" className="btn sm sv-yes" onClick={end} disabled={busy}>{busy ? "Ending…" : r.kind === "web" ? "Yes, revoke" : "Yes, end it"}</button>
          <button type="button" className="btn sm" onClick={() => setConfirm(false)} disabled={busy}>Cancel</button>
        </span>
      </div>
    );
  }
  return (
    <div className={block ? "sv-actions block" : "sv-actions"}>
      {onWatch && <button type="button" className="btn primary sv-watch" onClick={onWatch}><NavIcon name="monitor" size={15} /> Watch live</button>}
      {canEnd && <button type="button" className="btn danger" onClick={() => setConfirm(true)}>{r.kind === "web" ? "Revoke access" : "End session"}</button>}
    </div>
  );
}

function WatchGone({ onClose }: { onClose: () => void }) {
  return (
    <div className="sv-modal-wrap" onClick={onClose}>
      <div className="sv-gone" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <b>This session has ended</b>
        <span className="cell-sub">It is no longer running. If it was recorded, it is in Recordings.</span>
        <button type="button" className="btn" onClick={onClose}>Close</button>
      </div>
    </div>
  );
}

const FEED_TONE: Record<string, string> = { command: "ok", text: "warn", file: "violet", watch: "violet", control: "violet", message: "p", start: "muted" };

function WatchWindow({ r, now, workspace, canAct, onClose, onEnded, onToast }: {
  r: LiveRow; now: number | null; workspace: string; canAct: boolean;
  onClose: () => void; onEnded: (r: LiveRow, ok: boolean) => void; onToast: (msg: string, ok?: boolean) => void;
}) {
  const zone = useZone();
  const src = watchSrc(r);
  const id = sessionIdOf(r);
  const [feed, setFeed] = useState<FeedEvent[] | null>(null);
  const [fresh, setFresh] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const newest = useRef<string | null>(null);

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("keydown", onKey); prev?.focus?.(); };
  }, [onClose]);

  useEffect(() => {
    if (!id) return;
    let stop = false;
    const poll = async () => {
      const res = await fetch(`/api/admin/live/${id}/feed`, { cache: "no-store" }).catch(() => null);
      if (stop || !res) return;
      // 502: the data plane did not answer this time; keep what is shown and poll again.
      if (res.status === 502) return;
      if (!res.ok) { setFeed((f) => f ?? []); return; }
      const b = (await res.json()) as { events: FeedEvent[] };
      const top = b.events[0] ? `${b.events[0].at}|${b.events[0].text}` : null;
      if (newest.current && top && top !== newest.current) setFresh(top);
      newest.current = top;
      setFeed(b.events);
    };
    void poll();
    const t = setInterval(poll, 3000);
    return () => { stop = true; clearInterval(t); };
  }, [id]);
  useEffect(() => {
    if (!fresh) return;
    const t = setTimeout(() => setFresh(null), 6000);
    return () => clearTimeout(t);
  }, [fresh]);
  useEffect(() => {
    if (!banner) return;
    const t = setTimeout(() => setBanner(null), 6000);
    return () => clearTimeout(t);
  }, [banner]);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const t = text.trim();
    if (!t || !id) return;
    setSending(true);
    const res = await fetch(`/api/admin/live/${id}/message`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: t }) }).catch(() => null);
    setSending(false);
    if (res?.ok) {
      const { delivery } = (await res.json().catch(() => ({}))) as { delivery?: "shown" | "queued" | "none" };
      setText("");
      if (delivery === "none") {
        onToast("No terminal is open in this session, so the message can't be shown. It is in the activity list.", false);
        return;
      }
      setBanner(t);
      onToast(delivery === "queued" ? "The user is in a full-screen program. The message shows in their terminal when they leave it." : delivery === "shown" ? "Message shown in the user's terminal" : "Message shown on the user's screen");
    } else {
      onToast("Couldn't deliver the message. The session may have ended.", false);
    }
  }

  const clock = now === null ? "" : fmt(now, zone, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  const facts = useMemo(() => [
    ["Started", hm(r.startedAt, zone)],
    ["Duration", elapsed(r.startedAt, now)],
    ["IP address", r.clientIp || "—"],
    ["Access", accessOf(r, now)],
  ] as [string, string][], [r, zone, now]);

  // Full screen takes the stage with it: the picture, its watermark and the admin banner.
  const stageRef = useRef<HTMLDivElement>(null);
  const fullScreen = () => {
    const el = stageRef.current;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void el.requestFullscreen?.().catch(() => {});
  };

  return (
    <div className="sv-modal-wrap" onClick={onClose}>
      <div ref={ref} className="sv-modal" role="dialog" aria-modal="true" aria-label={`Live: ${r.userLabel} on ${r.siteName}`} tabIndex={-1} onClick={(e) => e.stopPropagation()}>
        <header className="sv-mhead">
          <span className="sv-livepill"><i aria-hidden="true" />LIVE · {elapsed(r.startedAt, now)}</span>
          <span className="sv-mtitle"><b>{r.userLabel}</b><span className="sv-arrow">→</span><span className={kindOf(r) === "rdp" ? "rv-chip remote" : "rv-chip"}>{labelOf(r)}</span><b>{r.siteName}</b>{hostOf(r) && <span className="mono cell-sub">{hostOf(r)}</span>}</span>
          {src && <button type="button" className="btn sm sv-full" onClick={fullScreen} title="Full screen (Esc to leave)">Full screen</button>}
          <button type="button" className="sv-x" aria-label="Close" onClick={onClose}>×</button>
        </header>
        <div className="sv-mbody">
          <div className="sv-mleft">
            <div ref={stageRef} className="sv-stage">
              {src ? <iframe src={src} title={`Live view: ${r.siteName}`} allow="clipboard-read; clipboard-write; fullscreen" /> : <span className="sv-nostage">This web app does not record, so it can&apos;t be watched.</span>}
              <span className="rv-mark mono" aria-hidden="true">{[workspace, r.userEmail ?? r.userLabel, r.siteName, clock].filter(Boolean).join(" · ")}</span>
              {banner && <span className="sv-banner"><b>ADMIN</b>{banner}</span>}
            </div>
            <p className="sv-note"><i aria-hidden="true" />{r.native && r.kind === "gateway" && r.protocol === "rdp" ? (r.controllable ? "The user is not told in their Remote Desktop app; the portal and the .rdp file say sessions may be watched or taken over. Take control in the view: their input is paused while you have it. The screen and typed text keep being recorded." : "The user is not told in their Remote Desktop app; the portal and the .rdp file say sessions may be watched. You can't control it. The screen and typed text keep being recorded.") : r.native ? (r.controllable ? "A line in the user's terminal tells them an admin is watching, and when you take or give back control; their typing is paused while you have it. The terminal and commands keep being recorded." : "A line in the user's terminal tells them an admin is watching. You can't type into it. The terminal and commands keep being recorded.") : "The user is told that this session is being watched. The screen and commands keep being recorded."}</p>
          </div>
          <aside className="sv-side">
            <dl className="sv-facts">{facts.map(([k, v]) => <div key={k}><dt>{k}</dt><dd className={k === "Started" || k === "Duration" || k === "IP address" ? "mono" : undefined}>{v}</dd></div>)}</dl>
            <div className="sv-feed">
              <span className="kcell-k">Live activity</span>
              {!id ? <p className="cell-sub">Activity is not tracked for web apps.</p> : feed === null ? <p className="cell-sub">Loading…</p> : feed.length === 0 ? <p className="cell-sub">Nothing yet.</p> : (
                <ol>
                  {feed.map((e) => {
                    const k = `${e.at}|${e.text}`;
                    return (
                      <li key={k + e.type} className={fresh === k ? "fresh" : undefined}>
                        <span className="mono sv-ft">{fmt(e.at, zone, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })}</span>
                        <span className={`rv-dot ${FEED_TONE[e.type] ?? "muted"}`} aria-hidden="true" />
                        <span className={e.type === "command" ? "mono" : undefined}>{e.type === "command" ? `$ ${e.text}` : e.text}</span>
                      </li>
                    );
                  })}
                </ol>
              )}
              {id && r.kind === "gateway" && !r.keystrokes ? <p className="cell-sub sv-feednote">Typed input is not shown: keystroke logging is off for this resource.</p> : null}
            </div>
            {canAct && id && r.native && r.kind === "gateway" && r.protocol === "rdp" ? (
              <p className="cell-sub sv-feednote">Messages can&apos;t reach a user&apos;s own Remote Desktop app.</p>
            ) : canAct && id && (
              <form className="sv-msg" onSubmit={send}>
                <input className="input" placeholder="Send the user a message…" value={text} maxLength={280} onChange={(e) => setText(e.target.value)} aria-label="Message to the user" />
                <button type="submit" className="btn" disabled={sending || !text.trim()}>{sending ? "Sending…" : "Send"}</button>
              </form>
            )}
            {canAct && <Actions r={r} canTerminate={canAct} onEnded={onEnded} block />}
          </aside>
        </div>
      </div>
    </div>
  );
}
