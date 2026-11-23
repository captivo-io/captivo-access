"use client";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef, useState } from "react";
import type { Terminal } from "@xterm/xterm";

type Frame = { t: "hello" | "open" | "o" | "r" | "close" | "end"; ch?: number; label?: string; cols?: number; rows?: number; d?: string };
type Tab = { ch: number; label: string; ended: boolean };

const RETRIES = 5;

/**
 * Watches a recorded native SSH session as it happens: the terminal the user
 * sees in their own SSH app, at its size, streamed from the jump host. A
 * connection that drops (the viewer fell behind, or the network blinked)
 * reconnects and redraws; one terminal per tab when the user has several open
 * over the same connection. An admin who takes control types into the
 * terminal on screen; the user's typing is paused meanwhile, and leaving the
 * view gives control back.
 */
export function TermLiveViewer({ sessionId, canControl, controlUrl, serverControlling }: { sessionId: string; canControl: boolean; controlUrl?: string; serverControlling?: boolean }) {
  const stageRef = useRef<HTMLDivElement>(null);
  const terms = useRef(new Map<number, { term: Terminal; host: HTMLDivElement; cols: number; rows: number }>());
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [active, setActive] = useState<number | null>(null);
  const picked = useRef(false); // the admin chose a tab; new terminals don't take over
  const activeRef = useRef<number | null>(null);
  const [state, setState] = useState<"connecting" | "live" | "ended" | "lost">("connecting");
  const showRef = useRef<(ch: number | null) => void>(() => {});
  const wsRef = useRef<WebSocket | null>(null);
  const [controlling, setControlling] = useState(false);
  const controllingRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [controlError, setControlError] = useState<string | null>(null);

  useEffect(() => { activeRef.current = active; }, [active]);
  useEffect(() => {
    controllingRef.current = controlling;
    for (const t of terms.current.values()) t.term.options.disableStdin = !controlling;
    if (controlling && activeRef.current !== null) terms.current.get(activeRef.current)?.term.focus();
  }, [controlling]);

  useEffect(() => {
    let gone = false, ws: WebSocket | null = null, tries = 0, ended = false;
    let xterm: typeof import("@xterm/xterm") | null = null;
    const stage = stageRef.current;

    const fit = (ch: number) => {
      const t = terms.current.get(ch);
      if (!t || !stage) return;
      const w = stage.clientWidth - 24, h = stage.clientHeight - 24;
      t.term.options.fontSize = Math.max(7, Math.min(18, Math.floor(Math.min(w / t.cols / 0.6, h / t.rows / 1.2))));
    };
    const show = (ch: number | null) => {
      for (const [n, t] of terms.current) t.host.hidden = n !== ch;
      if (ch !== null) {
        fit(ch);
        const t = terms.current.get(ch);
        t?.term.refresh(0, t.rows - 1);
      }
      setActive(ch);
    };
    const clear = () => {
      for (const t of terms.current.values()) { t.term.dispose(); t.host.remove(); }
      terms.current.clear();
      setTabs([]);
    };

    const onFrame = (f: Frame) => {
      if (!xterm || !stage) return;
      const ch = f.ch ?? 0;
      switch (f.t) {
        case "hello":
          // A (re)connection: the open frames that follow redraw everything.
          clear();
          tries = 0;
          setState("live");
          break;
        case "open": {
          const host = document.createElement("div");
          host.className = "term-host";
          stage.appendChild(host);
          const cols = f.cols ?? 80, rows = f.rows ?? 24;
          const term = new xterm.Terminal({
            cols, rows, disableStdin: !controllingRef.current, cursorBlink: false, convertEol: false, scrollback: 2000,
            fontFamily: '"Geist Mono", ui-monospace, Menlo, Consolas, monospace',
            theme: { background: "#0d1117", foreground: "#d6dde6", cursor: "#d6dde6" },
          });
          term.open(host);
          if (f.d) term.write(f.d);
          // Typing goes to the session only while this admin holds control.
          term.onData((d) => {
            if (controllingRef.current && wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(JSON.stringify({ t: "i", ch, d }));
          });
          terms.current.set(ch, { term, host, cols, rows });
          setTabs((ts) => [...ts.filter((t) => t.ch !== ch), { ch, label: f.label ?? "Terminal", ended: false }]);
          if (!picked.current || activeRef.current === null || !terms.current.has(activeRef.current)) show(ch);
          else host.hidden = true;
          break;
        }
        case "o":
          terms.current.get(ch)?.term.write(f.d ?? "");
          break;
        case "r": {
          const t = terms.current.get(ch);
          if (t && f.cols && f.rows) {
            t.cols = f.cols; t.rows = f.rows;
            t.term.resize(f.cols, f.rows);
            fit(ch);
          }
          break;
        }
        case "close":
          setTabs((ts) => ts.map((t) => (t.ch === ch ? { ...t, ended: true } : t)));
          break;
        case "end":
          ended = true;
          setState("ended");
          break;
      }
    };

    const connect = () => {
      if (gone) return;
      const proto = window.location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(`${proto}://${window.location.host}/guac-view?session=${encodeURIComponent(sessionId)}`);
      wsRef.current = ws;
      ws.onmessage = (e) => { try { onFrame(JSON.parse(String(e.data)) as Frame); } catch { /* not ours */ } };
      ws.onclose = () => {
        if (gone || ended) return;
        // The data plane gave control back when this view dropped.
        setControlling(false);
        if (++tries > RETRIES) { setState("lost"); return; }
        setState("connecting");
        setTimeout(connect, 1000 * tries);
      };
    };

    import("@xterm/xterm").then((m) => { xterm = m; connect(); }).catch(() => setState("lost"));
    const ro = new ResizeObserver(() => { if (activeRef.current !== null) fit(activeRef.current); });
    if (stage) ro.observe(stage);
    showRef.current = show;
    return () => {
      gone = true;
      ro.disconnect();
      ws?.close();
      clear();
    };
  }, [sessionId]);

  const pick = (ch: number) => {
    picked.current = true;
    showRef.current(ch);
    if (controllingRef.current) setTimeout(() => terms.current.get(ch)?.term.focus(), 0);
  };

  // Control taken back elsewhere (an admin, from a guest).
  useEffect(() => {
    if (serverControlling === false) setControlling(false);
  }, [serverControlling]);

  async function toggleControl() {
    setBusy(true);
    setControlError(null);
    const action = controlling ? "release" : "take";
    try {
      const res = await fetch(controlUrl ?? `/api/admin/live/${sessionId}/control`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action }) });
      const j = (await res.json().catch(() => ({}))) as { reason?: string };
      if (res.ok) setControlling(action === "take");
      else setControlError(j.reason === "control already held" ? (controlUrl ? "Someone else has control of this session." : "Another admin or an invited guest has control of this session.") : "Control could not be changed. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="tlive">
      <div className="tlive-bar">
        <span className={state === "live" ? "tlive-badge on" : "tlive-badge"}>● {state === "ended" ? "ENDED" : "LIVE"}</span>
        {tabs.length > 1 && (
          <div className="tlive-tabs" role="tablist" aria-label="The user's terminals">
            {tabs.map((t) => (
              <button key={t.ch} type="button" role="tab" aria-selected={t.ch === active} className={t.ch === active ? "on" : undefined} onClick={() => pick(t.ch)}>
                <span className="mono">{t.label}</span>{t.ended && <span className="tlive-off"> · closed</span>}
              </button>
            ))}
          </div>
        )}
        {canControl && state === "live" ? (
          <span className="tlive-ctl">
            {controlling && <span className="tlive-on">You have control · the user&apos;s typing is paused</span>}
            <button type="button" className="btn sm" disabled={busy} onClick={() => void toggleControl()}>{controlling ? "Give control back" : "Take control"}</button>
          </span>
        ) : (
          <span className="tlive-ro">View only</span>
        )}
      </div>
      {controlError && <div className="live-error" role="alert">{controlError}</div>}
      <div ref={stageRef} className="tlive-stage" aria-label="The user's terminal, live">
        {state === "connecting" && tabs.length === 0 && <span className="term-loading">Connecting to the session…</span>}
        {state === "live" && tabs.length === 0 && <span className="term-loading">No terminal is open yet. Commands and file transfers show in the activity list.</span>}
      </div>
      {state === "ended" && <div className="live-error">The session ended. It is in Recordings.</div>}
      {state === "lost" && <div className="live-error">The live view lost its connection. Close it and watch again.</div>}
    </div>
  );
}
