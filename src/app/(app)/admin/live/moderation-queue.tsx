"use client";
import { useEffect, useEffectEvent, useState } from "react";
import type { WaitingRequest } from "@/lib/moderation/requests";

const clock = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/**
 * Sessions waiting for a moderator. Joining admits the session: the user's
 * page connects, and once the session runs it opens here to watch (onStarted).
 */
export function ModerationQueue({ requests, now, onStarted, onToast }: {
  requests: WaitingRequest[]; now: number | null;
  onStarted: (sessionId: string) => void; onToast: (msg: string, ok?: boolean) => void;
}) {
  const [joining, setJoining] = useState<{ id: string; at: number; label: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // The parent passes new callbacks on every render (each second, for its
  // clocks); they must not restart the wait below.
  const started = useEffectEvent(onStarted);
  const toast = useEffectEvent(onToast);

  // After admitting, wait for the user's session to start, then watch it.
  useEffect(() => {
    if (!joining) return;
    let stop = false;
    const t = setInterval(async () => {
      const r = await fetch(`/api/admin/moderation/${joining.id}`, { cache: "no-store" }).catch(() => null);
      const j = r?.ok ? ((await r.json().catch(() => null)) as { status?: string; sessionId?: string | null } | null) : null;
      if (stop) return;
      if (j?.sessionId) { setJoining(null); started(j.sessionId); }
      else if (j?.status === "expired" || j?.status === "cancelled") { setJoining(null); toast(`${joining.label} didn't start the session`, false); }
    }, 1500);
    return () => { stop = true; clearInterval(t); };
  }, [joining]);

  async function decide(r: WaitingRequest, action: "admit" | "decline") {
    setBusy(r.id);
    const res = await fetch(`/api/admin/moderation/${r.id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action }) }).catch(() => null);
    setBusy(null);
    if (!res?.ok) {
      const j = (await res?.json().catch(() => null)) as { error?: string } | null;
      onToast(j?.error === "not_waiting" ? "Someone else already answered this request" : "Couldn't answer the request. Try again.", false);
      return;
    }
    if (action === "admit") setJoining({ id: r.id, at: Date.now(), label: r.userName });
    else onToast(`Declined ${r.userName}'s session`);
  }

  if (requests.length === 0 && !joining) return null;
  return (
    <section className="sv-modq" aria-label="Waiting for a moderator">
      <div className="sv-modq-head">
        <span className="kcell-k"><span className="rs-kdot warn" />Waiting for a moderator</span>
        <span className="cell-sub">These resources need a moderator. A session starts when you join it, and the user can work only while you watch.</span>
      </div>
      {joining && (
        <div className="sv-modq-row joining" role="status">
          <span className="sv-spin" aria-hidden="true" />
          <span className="sv-modq-t"><b>Starting {joining.label}&apos;s session…</b><span className="cell-sub">It opens here to watch as soon as their page connects.</span></span>
        </div>
      )}
      {requests.filter((r) => r.id !== joining?.id).map((r) => (
        <div key={r.id} className="sv-modq-row">
          <span className="au-av" aria-hidden="true">{r.userName.split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase()}</span>
          <span className="sv-modq-t">
            <b>{r.userName} <span className="sv-arrow">→</span> {r.siteName}</b>
            <span className="cell-sub">{r.userEmail} · {r.kind === "ssh" ? "Own SSH app, recorded" : "Browser session"} · waiting {now === null ? "" : clock(now - Date.parse(r.requestedAt))} · ends in {now === null ? "" : clock(Date.parse(r.expiresAt) - now)}</span>
          </span>
          <span className="sv-modq-b">
            <button type="button" className="btn sm primary" disabled={busy === r.id || !!joining} onClick={() => void decide(r, "admit")}>Join as moderator</button>
            <button type="button" className="btn sm ghost" disabled={busy === r.id} onClick={() => void decide(r, "decline")}>Decline</button>
          </span>
        </div>
      ))}
    </section>
  );
}
