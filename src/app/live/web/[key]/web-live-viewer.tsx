"use client";
import { useEffect, useRef, useState } from "react";
import { ConnectSplash } from "@/app/gateway/[siteId]/session/connect-splash";

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Admin viewer for a web app (transparent) tab: rrweb's Replayer in live mode,
 * fed over /web-view by the data-plane with the current page and then each
 * batch the vendor's recorder posts.
 *
 * Event times are rewritten to the viewer's clock on arrival. The vendor's
 * clock is not ours, and a page that sat idle before the admin opened it would
 * otherwise hold every new event back by the length of that pause; live mode
 * only needs their order, which arrival keeps.
 *
 * View only: the session runs in the vendor's own browser, so there is nothing
 * to take control of. End the session or revoke access from the live list.
 */
export function WebLiveViewer({ liveKey, label }: { liveKey: string; label?: string }) {
  const stageRef = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  const [ended, setEnded] = useState(false);

  useEffect(() => {
    let replayer: any = null;
    let ws: WebSocket | null = null;
    let disposed = false;
    let size = { width: 1280, height: 800 };

    const fit = () => {
      const stage = stageRef.current;
      const wrap = stage?.querySelector(".replayer-wrapper") as HTMLElement | null;
      if (!stage || !wrap) return;
      const scale = Math.min(stage.clientWidth / size.width, stage.clientHeight / size.height, 1);
      wrap.style.transformOrigin = "top left";
      wrap.style.transform = `scale(${scale})`;
      wrap.style.position = "absolute";
      wrap.style.left = `${Math.max(0, (stage.clientWidth - size.width * scale) / 2)}px`;
      wrap.style.top = `${Math.max(0, (stage.clientHeight - size.height * scale) / 2)}px`;
    };

    (async () => {
      const { Replayer } = await import("rrweb");
      await import("rrweb/dist/style.css");
      if (disposed || !stageRef.current) return;
      const proto = window.location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(`${proto}://${window.location.host}/web-view?key=${encodeURIComponent(liveKey)}`);
      ws.onmessage = (m) => {
        let events: any[] = [];
        try { events = JSON.parse(String(m.data)); } catch { return; }
        if (!Array.isArray(events) || events.length === 0) return;
        if (!replayer) {
          stageRef.current!.innerHTML = "";
          replayer = new Replayer([], { root: stageRef.current!, liveMode: true, mouseTail: false, UNSAFE_replayCanvas: false });
          replayer.on("resize", (d: { width: number; height: number }) => { size = d; fit(); });
          // Just before the first event's rewritten time: the current page plays at
          // once and what follows plays as it arrives (an earlier baseline lags
          // every event by the difference -- measured, 1 s for 1 s).
          replayer.startLive(Date.now() - events.length - 1);
          setReady(true);
        }
        let t = Date.now() - events.length;
        for (const e of events) {
          e.timestamp = t++;
          replayer.addEvent(e);
        }
        fit();
      };
      ws.onclose = () => { if (!disposed) setEnded(true); };
    })();
    window.addEventListener("resize", fit);
    return () => {
      disposed = true;
      window.removeEventListener("resize", fit);
      try { ws?.close(); } catch { /* ignore */ }
      try { replayer?.destroy?.(); } catch { /* ignore */ }
    };
  }, [liveKey]);

  return (
    <div style={{ position: "fixed", inset: 0, background: "#000", overflow: "hidden" }}>
      <div ref={stageRef} style={{ position: "absolute", inset: 0 }} />
      {!ready && !ended && <ConnectSplash siteName={label ?? "Web app"} />}
      {ended && (
        <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "#cbd5e1", zIndex: 70 }}>
          <p>{ready ? "The vendor has left this page, or the session ended." : "This session is no longer active."}</p>
        </div>
      )}
      <div className="live-badge" style={{ zIndex: 60 }}>● LIVE · VIEW ONLY</div>
    </div>
  );
}
