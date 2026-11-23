"use client";
/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useRef, useState } from "react";

/**
 * A live session's screen. An admin's page by default; an invited guest's page
 * passes its own control endpoint, and what the server says about control
 * (serverControlling) so a take-back by an admin stops the guest's input here.
 */
export function LiveViewer({ sessionId, canControl, controlUrl, serverControlling }: { sessionId: string; canControl: boolean; controlUrl?: string; serverControlling?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const clientRef = useRef<any>(null);
  const guacRef = useRef<any>(null); // the guacamole-common-js module
  const inputRef = useRef<{ keyboard?: any; mouse?: any }>({});
  const [error, setError] = useState<string | null>(null);
  const [controlling, setControlling] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let disposed = false;
    (async () => {
      const mod: any = await import("guacamole-common-js");
      const Guacamole = mod.default ?? mod;
      guacRef.current = Guacamole;
      const proto = window.location.protocol === "https:" ? "wss" : "ws";
      const tunnel = new Guacamole.WebSocketTunnel(`${proto}://${window.location.host}/guac-view`);
      const client = new Guacamole.Client(tunnel);
      clientRef.current = client;
      const fail = () => setError("The session ended or is no longer available.");
      tunnel.onerror = fail;
      client.onerror = fail;

      const display = client.getDisplay();
      const el = display.getElement();
      if (ref.current) {
        ref.current.innerHTML = "";
        ref.current.appendChild(el);
      }
      if (disposed) return;

      const fit = () => {
        const dw = display.getWidth();
        const dh = display.getHeight();
        // The stage's own size: on a guest's page a bar takes the bottom of the window.
        const sw = ref.current?.clientWidth || window.innerWidth;
        const sh = ref.current?.clientHeight || window.innerHeight;
        if (dw > 0 && dh > 0) display.scale(Math.min(sw / dw, sh / dh));
      };
      display.onresize = fit;
      window.addEventListener("resize", fit);

      client.connect(`session=${encodeURIComponent(sessionId)}`);
    })().catch(() => setError("Couldn't start the viewer."));

    return () => {
      disposed = true;
      try {
        detachInput();
        clientRef.current?.disconnect();
      } catch {
        /* ignore */
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  function attachInput() {
    const client = clientRef.current;
    const G = guacRef.current;
    if (!client || !G) return;
    const el = client.getDisplay().getElement();
    const keyboard = new G.Keyboard(document);
    keyboard.onkeydown = (k: number) => client.sendKeyEvent(1, k);
    keyboard.onkeyup = (k: number) => client.sendKeyEvent(0, k);
    const mouse = new G.Mouse(el);
    // In display units: the view is scaled to the window.
    const send = (s: any) => client.sendMouseState(s, true);
    mouse.onmousedown = send;
    mouse.onmouseup = send;
    mouse.onmousemove = send;
    inputRef.current = { keyboard, mouse };
  }
  function detachInput() {
    const { keyboard, mouse } = inputRef.current;
    if (keyboard) {
      keyboard.onkeydown = null;
      keyboard.onkeyup = null;
    }
    if (mouse) {
      mouse.onmousedown = null;
      mouse.onmouseup = null;
      mouse.onmousemove = null;
    }
    inputRef.current = {};
  }

  // Ctrl+Alt+Del can't be typed from a browser (the local system takes it).
  function sendCtrlAltDel() {
    const client = clientRef.current;
    if (!client) return;
    for (const k of [0xffe3, 0xffe9, 0xffff]) client.sendKeyEvent(1, k);
    for (const k of [0xffff, 0xffe9, 0xffe3]) client.sendKeyEvent(0, k);
  }

  // Control taken back elsewhere (an admin, from a guest): stop sending input.
  useEffect(() => {
    if (serverControlling === false && controlling) {
      detachInput();
      setControlling(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverControlling]);

  async function toggleControl() {
    setBusy(true);
    const action = controlling ? "release" : "take";
    try {
      const res = await fetch(controlUrl ?? `/api/admin/live/${sessionId}/control`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (res.ok) {
        if (action === "take") {
          attachInput();
          setControlling(true);
        } else {
          detachInput();
          setControlling(false);
        }
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="lv-root">
      <div ref={ref} style={{ position: "absolute", inset: 0 }} />
      <div className="live-badge">● LIVE{controlling ? " · CONTROLLING" : ""}</div>
      {canControl && (
        <span className="live-control">
          {controlling && <button type="button" className="btn sm" onClick={sendCtrlAltDel}>Ctrl+Alt+Del</button>}
          <button type="button" className="btn sm" disabled={busy} onClick={toggleControl}>
            {controlling ? "Release control" : "Take control"}
          </button>
        </span>
      )}
      {error && <div className="live-error">{error}</div>}
    </div>
  );
}
