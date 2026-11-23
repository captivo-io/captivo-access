"use client";
import { useEffect, useState } from "react";
import { LiveViewer } from "@/app/live/[sessionId]/live-viewer";
import { TermLiveViewer } from "@/app/live/[sessionId]/term-live-viewer";

type State = { state: "live" | "ended" | "removed" | "expired" | "none"; controlling?: boolean; controlledByOther?: boolean };

const ENDED: Record<Exclude<State["state"], "live">, string> = {
  ended: "The session has ended.",
  removed: "An administrator removed you from this session.",
  expired: "Your invite has expired.",
  none: "Your invite has ended.",
};

function left(iso: string, now: number): string {
  const m = Math.max(0, Math.round((new Date(iso).getTime() - now) / 60_000));
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min left` : `${m} min left`;
}

/**
 * The guest's page: the session's screen (or terminal), who they are watching,
 * how long the invite has left, and their address across the picture so a
 * screenshot shows whose view it was. It polls the invite's state, so a
 * take-back, a removal or the end of the session shows here at once.
 */
export function GuestWatch(p: {
  sessionId: string; terminal: boolean; canControl: boolean; guestName: string; guestEmail: string;
  userLabel: string; siteName: string; expiresAt: string; untilSessionEnds: boolean;
}) {
  const [st, setSt] = useState<State>({ state: "live" });
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    let stop = false;
    const poll = async () => {
      const r = await fetch("/api/join/state", { cache: "no-store" }).catch(() => null);
      if (stop || !r?.ok) return;
      const j = (await r.json().catch(() => null)) as State | null;
      if (j && !stop) setSt(j);
    };
    void poll();
    const t = setInterval(() => { setNow(Date.now()); void poll(); }, 4000);
    setNow(Date.now());
    return () => { stop = true; clearInterval(t); };
  }, []);

  if (st.state !== "live") {
    return (
      <div className="gw-ended" role="status">
        <b>{ENDED[st.state]}</b>
        <span>You can close this page.</span>
      </div>
    );
  }
  const serverControlling = st.controlling ?? undefined;
  return (
    <div className="gw">
      {p.terminal
        ? <TermLiveViewer sessionId={p.sessionId} canControl={p.canControl && !st.controlledByOther} controlUrl="/api/join/control" serverControlling={serverControlling} />
        : <LiveViewer sessionId={p.sessionId} canControl={p.canControl && !st.controlledByOther} controlUrl="/api/join/control" serverControlling={serverControlling} />}
      <div className="gw-mark" aria-hidden="true">{Array.from({ length: 24 }, (_, i) => <span key={i}>{p.guestEmail}</span>)}</div>
      <div className="gw-bar" role="status">
        <span><b>{p.userLabel}</b> on <b>{p.siteName}</b></span>
        <span>You: {p.guestName} (guest){p.canControl ? "" : " · view only"}</span>
        {st.controlledByOther && <span className="gw-held">An admin has control</span>}
        <span>{p.untilSessionEnds ? "Until the session ends" : now === null ? "" : left(p.expiresAt, now)}</span>
        <span>Recorded</span>
      </div>
    </div>
  );
}
