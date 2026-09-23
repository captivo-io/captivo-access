"use client";
/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useRef, useState } from "react";
import { clipboardCaps } from "@/lib/gateway/clipboard-caps";
import { createClipboardBridge, type ClipboardBridge } from "./clipboard";
import { pasteKeySequence, isBrowserPasteKey, KEYSYM, type GatewayProtocol } from "@/lib/gateway/paste-keys";
import { ConnectSplash } from "./connect-splash";
import { OnScreenKeyboard } from "./on-screen-keyboard";
import { SessionControlPanel } from "./session-control-panel";

// Fullscreen HTML5 session: embeds guacamole-common-js and points it at the
// data-plane guac-tunnel (same origin, fronted by nginx). The server drives the
// guacd handshake + credential injection; this only renders + sends input.
export function GatewaySession({ siteId, siteName, recorded, clipboardMode, protocol = "RDP" }: { siteId: string; siteName: string; recorded: boolean; clipboardMode: string; protocol?: GatewayProtocol }) {
  const caps = clipboardCaps(clipboardMode);
  const ref = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [watching, setWatching] = useState(false);
  const [controlHeld, setControlHeld] = useState(false);
  const guacRef = useRef<any>(null);
  const fsRef = useRef<any>(null);
  const clientRef = useRef<any>(null);
  const clipRef = useRef<ClipboardBridge | null>(null);
  const keyboardRef = useRef<any>(null);
  const keyHandlersRef = useRef<{ kd: (k: number) => void; ku: (k: number) => void } | null>(null);
  const clipboardOpenRef = useRef(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const [clipboardOpen, setClipboardOpen] = useState(false);
  const [canUpload, setCanUpload] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [autoSyncBlocked, setAutoSyncBlocked] = useState(false);
  // Modifier state as forwarded to the remote, so the Ctrl+V intercept and the
  // replayed paste chord never double-press Ctrl.
  const modsRef = useRef({ ctrl: false, alt: false, shift: false, insert: false });

  // Press `keys` in order and release in reverse on the remote.
  const sendChord = (keys: number[]) => {
    const c = clientRef.current;
    if (!c) return;
    for (const k of keys) c.sendKeyEvent(1, k);
    for (const k of [...keys].reverse()) c.sendKeyEvent(0, k);
  };
  // Push text into guacd's clipboard and make the remote paste it now.
  const pasteIntoSession = (text: string): boolean => {
    const r = clipRef.current?.pushLocal(text);
    if (r === "blocked") return false;
    sendChord(pasteKeySequence(protocol, modsRef.current.ctrl));
    return true;
  };

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(t);
  }, [toast]);

  // While the clipboard panel is open the guac keyboard is suspended so keys go
  // to the textarea instead of the remote; reset() first releases Ctrl/Alt/Shift
  // already sent to the remote so no modifier sticks.
  const suspendKeyboard = () => {
    const kb = keyboardRef.current;
    if (!kb) return;
    kb.reset();
    kb.onkeydown = null;
    kb.onkeyup = null;
  };
  const resumeKeyboard = () => {
    const kb = keyboardRef.current, h = keyHandlersRef.current;
    if (kb && h) { kb.onkeydown = h.kd; kb.onkeyup = h.ku; }
  };
  const closeClipboard = () => { clipboardOpenRef.current = false; setClipboardOpen(false); };
  const toggleFs = () => {
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    else document.documentElement.requestFullscreen?.().catch(() => {});
  };

  useEffect(() => {
    if (clipboardOpen) {
      suspendKeyboard();
      const ta = taRef.current;
      if (ta) {
        ta.value = caps.allowCopyOut ? (clipRef.current?.getRemoteText() ?? "") : "";
        ta.readOnly = !caps.allowPasteIn;
        ta.focus();
        ta.select();
      }
    } else {
      resumeKeyboard();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clipboardOpen]);

  // Guacamole convention: Ctrl+Alt+Shift toggles the clipboard panel. Capture
  // phase so it preempts the guac keyboard; Esc closes while open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.altKey && e.shiftKey && !e.repeat) {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (clipboardOpenRef.current) {
          closeClipboard();
        } else {
          clipboardOpenRef.current = true;
          setClipboardOpen(true);
        }
      } else if (clipboardOpenRef.current && e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        closeClipboard();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const fs = fsRef.current, G = guacRef.current;
    if (!e.dataTransfer?.files?.length || !G) return;
    if (!fs) {
      // guacd only exposes a filesystem when file transfer is enabled for the
      // resource (SFTP for SSH, a mapped drive for RDP) — never fail silently.
      setToast("File transfer is not enabled for this resource — ask your admin to turn it on.");
      return;
    }
    for (const file of Array.from(e.dataTransfer.files)) {
      setToast(`Uploading ${file.name}…`);
      // Read the whole file, then stream it with ArrayBufferWriter (which chunks +
      // sends every blob in order, then we end the stream). We deliberately avoid
      // Guacamole.BlobWriter: its ack-chained sender reuses a single FileReader and,
      // when an extra stream-open ack advances it twice, silently skips one 6 KB
      // blob — corrupting large multi-chunk uploads (verified: one chunk dropped
      // mid-file). ArrayBufferWriter has no such ack-timing race.
      const fr = new FileReader();
      fr.onerror = () => setToast(`Upload failed: ${file.name}`);
      fr.onload = () => {
        const stream = fs.createOutputStream(file.type || "application/octet-stream", "/" + file.name);
        const writer = new G.ArrayBufferWriter(stream);
        writer.onack = (status: any) => {
          if (status.isError()) setToast(`Upload failed: ${file.name}`);
        };
        writer.sendData(fr.result);
        writer.sendEnd();
        setToast(`Uploaded ${file.name}`);
      };
      fr.readAsArrayBuffer(file);
    }
  };

  useEffect(() => {
    let client: any;
    let keyboard: any;
    let onResize: (() => void) | null = null;
    let onFocus: (() => void) | null = null;
    let onPaste: ((e: ClipboardEvent) => void) | null = null;
    let disposed = false;
    // Fallback: reveal the real canvas/error if guacd never reaches CONNECTED, so
    // the vendor is never stuck behind the splash.
    const readyTimer = window.setTimeout(() => setReady(true), 20000);

    (async () => {
      const mod: any = await import("guacamole-common-js");
      const Guacamole = mod.default ?? mod;
      const proto = window.location.protocol === "https:" ? "wss" : "ws";
      // The tunnel URL must carry NO query — guacamole-common-js appends "?"+data.
      const tunnel = new Guacamole.WebSocketTunnel(`${proto}://${window.location.host}/guac-tunnel`);
      client = new Guacamole.Client(tunnel);
      clientRef.current = client;
      const fail = () => setError("The session ended or could not start.");
      tunnel.onerror = fail;
      client.onerror = fail;
      // Dismiss the connect splash once guacd reaches CONNECTED (state 3).
      client.onstatechange = (state: number) => { if (state === 3 && !disposed) setReady(true); };

      guacRef.current = Guacamole;
      client.onfile = (stream: any, mimetype: string, filename: string) => {
        if (!disposed) setToast(`Downloading ${filename}…`);
        const reader = new Guacamole.BlobReader(stream, mimetype);
        reader.onend = () => {
          try {
            const url = URL.createObjectURL(reader.getBlob());
            const a = document.createElement("a");
            a.href = url; a.download = filename; a.style.display = "none";
            document.body.appendChild(a); a.click();
            // Remove + revoke only after the browser has started the download —
            // doing it synchronously after click() cancels it silently.
            setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 2000);
            if (!disposed) setToast(`Downloaded ${filename}`);
          } catch {
            if (!disposed) setToast(`Download failed: ${filename}`);
          }
        };
        // guacd streams downloads on demand: after the "file" instruction it sends
        // the first blob only once the client acknowledges the stream. The Client
        // sends no ack when onfile is handled, and BlobReader only acks blobs as
        // they arrive — so without this initial ack guacd waits forever, no blob or
        // end ever comes, and onend never fires. This kicks off the transfer.
        stream.sendAck("OK", 0);
      };
      client.onfilesystem = (object: any) => {
        fsRef.current = object;
        if (!disposed) setCanUpload(true);
      };
      clipRef.current = createClipboardBridge(client, Guacamole, caps, (b) => { if (!disposed) setAutoSyncBlocked(b); });

      const display = client.getDisplay();
      const el = display.getElement();
      if (ref.current) {
        ref.current.innerHTML = "";
        ref.current.appendChild(el);
      }
      if (disposed) return;

      const vw = () => Math.floor(window.innerWidth);
      const vh = () => Math.floor(window.innerHeight);
      // Fixed 96 DPI (100% scale). Multiplying by devicePixelRatio (e.g. 2 on a
      // Retina Mac) made the RDP target render at 200% — icons/text too large.
      const dpi = 96;

      // Scale the rendered display to exactly fit the viewport.
      const fit = () => {
        const dw = display.getWidth();
        const dh = display.getHeight();
        if (dw > 0 && dh > 0) display.scale(Math.min(window.innerWidth / dw, window.innerHeight / dh));
      };
      display.onresize = fit;

      client.connect(`site=${encodeURIComponent(siteId)}&w=${vw()}&h=${vh()}&dpi=${dpi}`);

      keyboard = new Guacamole.Keyboard(document);
      const trackMods = (k: number, down: boolean) => {
        if (k === KEYSYM.ctrlL || k === KEYSYM.ctrlR) modsRef.current.ctrl = down;
        if (k === KEYSYM.altL || k === KEYSYM.altR) modsRef.current.alt = down;
        if (k === KEYSYM.shiftL || k === KEYSYM.shiftR) modsRef.current.shift = down;
        if (k === KEYSYM.insert) modsRef.current.insert = down;
      };
      // Ctrl+V is the browser's paste gesture: swallow the `v` (Ctrl itself was
      // already forwarded) and let the browser's default fire the `paste` event
      // below, which carries the clipboard text with no permission prompt.
      // Returning false = don't preventDefault, so that event actually fires.
      const kd = (k: number) => {
        trackMods(k, true);
        if (isBrowserPasteKey(k, modsRef.current)) return false;
        client.sendKeyEvent(1, k);
        return false;
      };
      const ku = (k: number) => {
        trackMods(k, false);
        if (isBrowserPasteKey(k, modsRef.current)) return false;
        client.sendKeyEvent(0, k);
        return false;
      };
      keyboard.onkeydown = kd;
      keyboard.onkeyup = ku;
      keyboardRef.current = keyboard;
      keyHandlersRef.current = { kd, ku };

      const mouse = new Guacamole.Mouse(el);
      const send = (state: any) => client.sendMouseState(state);
      mouse.onmousedown = send;
      mouse.onmouseup = send;
      mouse.onmousemove = send;

      // On window resize, ask the remote to match the new viewport, then refit.
      onResize = () => {
        try {
          client.sendSize(vw(), vh());
        } catch {
          /* ignore */
        }
        fit();
      };
      window.addEventListener("resize", onResize);
      // Push the browser clipboard to the remote whenever the session regains
      // focus (and once now), so a Ctrl+V inside the session pastes it. Silent
      // no-op where the Clipboard API is blocked — the manual panel covers that.
      onFocus = () => clipRef.current?.syncFromBrowser();
      window.addEventListener("focus", onFocus);
      // The paste gesture (Ctrl+V / Shift+Insert / Edit → Paste): the browser hands
      // us the clipboard text directly. Ignored while the panel's textarea has it.
      onPaste = (e: ClipboardEvent) => {
        if (clipboardOpenRef.current) return;
        const text = e.clipboardData?.getData("text/plain") ?? "";
        e.preventDefault();
        // Shift+Insert was forwarded to the remote as-is (a desktop pastes on it
        // itself): only refresh guacd's clipboard, don't replay a second paste.
        const shiftInsert = modsRef.current.shift && modsRef.current.insert;
        if (!caps.allowPasteIn) {
          // Paste-in is blocked by policy: forward the plain chord so a remote-side
          // paste (its own clipboard) still behaves as before.
          if (!shiftInsert) sendChord(pasteKeySequence(protocol, modsRef.current.ctrl));
          return;
        }
        if (shiftInsert) clipRef.current?.pushLocal(text);
        else pasteIntoSession(text);
      };
      document.addEventListener("paste", onPaste);
      fit();
      clipRef.current?.syncFromBrowser();
    })().catch(() => setError("Couldn't start the session."));

    return () => {
      disposed = true;
      window.clearTimeout(readyTimer);
      try {
        if (onResize) window.removeEventListener("resize", onResize);
        if (onFocus) window.removeEventListener("focus", onFocus);
        if (onPaste) document.removeEventListener("paste", onPaste);
        if (keyboard) {
          keyboard.onkeydown = null;
          keyboard.onkeyup = null;
        }
        client?.disconnect();
      } catch {
        /* ignore */
      }
    };
  }, [siteId]);

  useEffect(() => {
    let stop = false;
    const poll = async () => {
      try {
        const res = await fetch(`/api/gateway/${siteId}/watch-status`, { cache: "no-store" });
        if (res.ok) {
          const s = (await res.json()) as { watching: boolean; controlHeld: boolean };
          if (!stop) {
            setWatching(s.watching);
            setControlHeld(s.controlHeld);
          }
        }
      } catch {
        /* ignore */
      }
    };
    void poll();
    const t = setInterval(poll, 2000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [siteId]);

  return (
    <div style={{ position: "fixed", inset: 0, background: "#000", overflow: "hidden", cursor: "none" }} onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
      {!ready && !error && <ConnectSplash siteName={siteName} />}
      {/* Dedicated display target: the guac client clears this via innerHTML, so the
          overlays below must NOT live inside it (they'd be wiped on connect). */}
      <div ref={ref} style={{ position: "absolute", inset: 0 }} />
      {ready && (
        <>
          <SessionControlPanel
            actions={[
              { key: "fs", label: "Full screen", sublabel: "Fill the screen", onClick: toggleFs },
              { key: "clip", label: "Clipboard", status: `${caps.allowCopyOut ? "copy" : "no-copy"} · ${caps.allowPasteIn ? "paste" : "no-paste"}${autoSyncBlocked && caps.allowPasteIn ? " · Ctrl+V to paste" : ""}`, onClick: () => setClipboardOpen(true) },
              { key: "leave", label: "Leave session", sublabel: "Disconnect", onClick: () => clientRef.current?.disconnect() },
            ]}
          />
          <OnScreenKeyboard sendKey={(keysym, pressed) => clientRef.current?.sendKeyEvent(pressed ? 1 : 0, keysym)} />
        </>
      )}
      {recorded && (
        <div
          style={{
            position: "fixed", top: 12, left: 12, zIndex: 20, pointerEvents: "none",
            display: "flex", alignItems: "center", gap: 6,
            background: "rgba(0,0,0,0.6)", color: "#ff4d4f",
            font: "600 12px/1 sans-serif", letterSpacing: "0.06em",
            padding: "6px 10px", borderRadius: 6,
          }}
        >
          <span style={{ width: 7, height: 7, borderRadius: "50%", background: "#ff4d4f", display: "inline-block" }} />
          RECORDED
        </div>
      )}
      {(watching || controlHeld) && (
        <div
          style={{
            position: "fixed", top: 8, left: "50%", transform: "translateX(-50%)", zIndex: 20,
            pointerEvents: "none", // never intercept clicks — they must reach the session (e.g. the window close button)
            background: controlHeld ? "rgba(180,0,0,0.92)" : "rgba(0,0,0,0.72)",
            color: "#fff", padding: "6px 14px", borderRadius: 8, fontFamily: "sans-serif", fontSize: "13px", whiteSpace: "nowrap",
          }}
        >
          {controlHeld ? "An administrator has taken control of this session." : "This session is being monitored live."}
        </div>
      )}
      {canUpload && <div className="ft-hint">Drop files to upload</div>}
      {toast && <div className="ft-toast">{toast}</div>}
      {clipboardOpen && (
        <div className="clip-overlay" role="dialog" aria-label="Clipboard" aria-modal="true">
          <div className="clip-panel">
            <div className="clip-title">Clipboard</div>
            {(caps.allowCopyOut || caps.allowPasteIn) ? (
              <>
                <textarea
                  ref={taRef}
                  className="clip-ta"
                  spellCheck={false}
                  placeholder={caps.allowPasteIn ? "Paste text here — Send types it into the session." : "Remote clipboard (read-only)"}
                />
                <div className="clip-actions">
                  {caps.allowPasteIn && (
                    <button
                      type="button"
                      className="clip-btn clip-btn-primary"
                      onClick={() => {
                        const text = taRef.current?.value ?? "";
                        closeClipboard();
                        if (text && pasteIntoSession(text)) setToast("Pasted into the session");
                      }}
                    >
                      Send to session
                    </button>
                  )}
                  <button type="button" className="clip-btn" onClick={closeClipboard}>Close</button>
                </div>
                <div className="clip-hint">
                  Ctrl+V pastes your clipboard straight into the session{protocol === "SSH" ? " · right-click pastes in the terminal" : ""}
                  {autoSyncBlocked && caps.allowPasteIn ? " · automatic sync is blocked by this browser, Ctrl+V still works" : ""}
                  {" · "}Ctrl+Alt+Shift toggles this panel · Esc closes
                </div>
              </>
            ) : (
              <>
                <div className="clip-disabled">Clipboard is disabled for this resource.</div>
                <div className="clip-actions"><button type="button" className="clip-btn" onClick={closeClipboard}>Close</button></div>
              </>
            )}
          </div>
        </div>
      )}
      {error && (
        <div style={{ color: "#fff", padding: "1.25rem", fontFamily: "sans-serif" }}>{error}</div>
      )}
    </div>
  );
}
