"use client";
import { useEffect, useRef, useState } from "react";
import { ConnectSplash } from "./connect-splash";
import { isolatedDims } from "@/lib/isolated/dims";
import { OnScreenKeyboard } from "./on-screen-keyboard";
import { SessionPanel } from "./shell/session-panel";
import { RecordingNotice, MonitorNotice, SessionToast, DropOverlay, FirstTips, type ToastState } from "./shell/notices";

// ?site pins the session for the data-plane; it sets a cookie so the KasmVNC
// client's follow-up asset/WS requests (which carry no ?site) inherit it.
// path= keeps the client's RFB WebSocket under /kasm-tunnel/ (its default absolute
// /websockify would route to the manager, not the data-plane). clipboard_* turn ON
// the client's seamless clipboard (OFF by default); per-direction policy is still
// enforced server-side by the broker's DLP config.
// resize=scale (not remote): the isolated desktop is sized ONCE (to the vendor's
// viewport, see isolatedDims) and the client scales it to whatever the viewport
// becomes (e.g. after toggling full screen). resize=remote would grow the desktop
// past the recorder's fixed x11grab region, so recordings would only capture the
// top-left corner — scale keeps desktop and recording in lockstep.
// show_control_bar=false hides KasmVNC's own side bar: Captivo's shell is the UI.
const KASM_PARAMS = "path=kasm-tunnel/websockify&resize=scale&show_control_bar=false&clipboard_seamless=true&clipboard_up=true&clipboard_down=true";

// Streaming quality presets → KasmVNC client settings (JPEG/WebP quality ladder
// and video-mode quality). Chosen per vendor browser; applied at connect.
type Quality = "auto" | "saver" | "best";
const QUALITY_PARAMS: Record<Quality, string> = {
  auto: "",
  saver: "&quality=3&dynamic_quality_min=2&dynamic_quality_max=6&video_quality=1&enable_webp=true",
  best: "&quality=9&dynamic_quality_min=7&dynamic_quality_max=9&treat_lossless=9&video_quality=3&enable_webp=true",
};
const QUALITY_LABEL: Record<Quality, string> = { auto: "Auto (adaptive)", saver: "Bandwidth saver", best: "Best quality" };
const QUALITY_KEY = "ca_iso_quality";
function readQuality(): Quality {
  try { const v = localStorage.getItem(QUALITY_KEY); if (v === "saver" || v === "best") return v; } catch { /* ignore */ }
  return "auto";
}

export function IsolatedSession({ siteId, siteName, recorded, fileTransferMode }: { siteId: string; siteName: string; recorded: boolean; fileTransferMode: string }) {
  const canUpload = fileTransferMode === "allow" || fileTransferMode === "no_download";
  const canDownload = fileTransferMode === "allow" || fileTransferMode === "no_upload";
  const [ready, setReady] = useState(false);
  const [watching, setWatching] = useState(false);
  const [controlHeld, setControlHeld] = useState(false);
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  const [quality, setQuality] = useState<Quality>("auto");
  const [gen, setGen] = useState(0); // bump to reconnect the iframe (new isolated session)
  useEffect(() => { setQuality(readQuality()); }, []);
  const cycleQuality = () => {
    const order: Quality[] = ["auto", "saver", "best"];
    const next = order[(order.indexOf(quality) + 1) % order.length];
    try { localStorage.setItem(QUALITY_KEY, next); } catch { /* ignore */ }
    setQuality(next);
    setReady(false); setConnectedAt(null);
    setGen((g) => g + 1);
    setToast(`Streaming quality: ${QUALITY_LABEL[next]} — reconnecting`, "info");
  };
  const [fs, setFs] = useState(false);
  const [downloads, setDownloads] = useState<{ name: string; size: number; mtime: number }[]>([]);
  const [toast, setToastState] = useState<ToastState | null>(null);
  const setToast = (text: string | null, tone: ToastState["tone"] = "info") => setToastState(text ? { text, tone } : null);
  const [dropState, setDropState] = useState<"idle" | "over" | "blocked">("idle");
  const dragDepth = useRef(0);
  const [connectedAt, setConnectedAt] = useState<number | null>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToastState(null), 3500);
    return () => clearTimeout(t);
  }, [toast]);

  // Poll the isolated browser's Downloads folder so files it downloads surface to
  // the vendor. Only when the site allows downloads out.
  useEffect(() => {
    if (!canDownload) return;
    let stop = false;
    const poll = async () => {
      try {
        const res = await fetch(`/api/isolated/files/downloads?site=${siteId}`, { cache: "no-store" });
        if (res.ok && !stop) setDownloads((await res.json()) as { name: string; size: number; mtime: number }[]);
      } catch {
        /* ignore */
      }
    };
    void poll();
    const t = setInterval(poll, 3000);
    return () => { stop = true; clearInterval(t); };
  }, [siteId, canDownload]);

  const uploadFile = async (f: File) => {
    setToast(`Uploading ${f.name}…`);
    try {
      const res = await fetch(`/api/isolated/files/upload?site=${siteId}&name=${encodeURIComponent(f.name)}`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream", "content-length": String(f.size) },
        body: f,
      });
      if (res.ok) setToast(`Uploaded ${f.name} — find it in the browser's Downloads folder`, "ok");
      else setToast(res.status === 413 ? `${f.name} is too large` : `Upload failed: ${f.name}`, "danger");
    } catch {
      setToast(`Upload failed: ${f.name}`, "danger");
    }
  };
  const onPick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (f) await uploadFile(f);
  };
  // Drag-and-drop onto the session (the iframe swallows drag events over the
  // canvas, so a transparent catcher sits above it only while files are dragged).
  const hasFiles = (e: React.DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");
  const onDragEnter = (e: React.DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth.current += 1;
    setDropState(canUpload ? "over" : "blocked");
  };
  const onDragLeave = (e: React.DragEvent) => {
    if (!hasFiles(e)) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDropState("idle");
  };
  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    dragDepth.current = 0;
    setDropState("idle");
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (files.length === 0) return;
    if (!canUpload) { setToast("File transfer is disabled for this resource", "warn"); return; }
    for (const f of files) await uploadFile(f);
  };

  // The KasmVNC/noVNC hidden keyboard input inside the same-origin iframe. Focusing
  // it raises the phone soft keyboard; noVNC then captures typing.
  const kbInput = (): HTMLElement | null => {
    const doc = frameRef.current?.contentDocument;
    return (doc?.getElementById("noVNC_keyboard") as HTMLElement | null)
      ?? (doc?.querySelector("textarea, input[type=text]") as HTMLElement | null);
  };

  // Send a raw X11 keysym to the isolated session for the shared OnScreenKeyboard:
  // prefer the RFB API if the bundle exposes it, else a synthetic KeyboardEvent on
  // the hidden keyboard input (best-effort — the embed may ignore synthetic events).
  const sendKeysym = (keysym: number, pressed: boolean) => {
    const el = kbInput();
    if (!el) return;
    el.focus();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rfb: any = (frameRef.current?.contentWindow as any)?.rfb;
    if (rfb?.sendKey) { rfb.sendKey(keysym, null, pressed); return; }
    if (!pressed) return; // synthetic path fires on the down edge only
    const ch = keysym >= 0x20 && keysym <= 0x7e ? String.fromCharCode(keysym) : "";
    el.dispatchEvent(new KeyboardEvent("keydown", { key: ch || " ", bubbles: true }));
  };

  // The macOS green button only maximises the browser window — it keeps the tab/URL
  // chrome, so the screen-sized desktop still letterboxes. The Fullscreen API hides
  // ALL chrome, making the viewport equal the screen (= the desktop) for an exact fill.
  useEffect(() => {
    const onFs = () => setFs(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);
  const toggleFs = () => {
    if (document.fullscreenElement) {
      document.exitFullscreen?.().catch(() => {});
    } else {
      document.documentElement.requestFullscreen?.().catch(() => {});
    }
  };

  // Size the isolated desktop to the vendor's CURRENT viewport (not the physical
  // screen): with resize=scale the desktop is scaled to fit, and a screen-sized
  // desktop shown in a browser window whose aspect differs (tab bar, dock) was
  // letterboxed — dark bands and a blurry, offset page. Matching the viewport gives
  // a 1:1 fill; toggling full screen afterwards only changes the aspect slightly.
  // The broker keeps this size fixed for the session, so recordings stay correct.
  useEffect(() => {
    const touch = typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches;
    setDims(isolatedDims(touch, window.innerWidth, window.innerHeight, window.innerWidth, window.innerHeight));
  }, []);

  // Mirror GatewaySession: poll whether an admin is watching / has taken control so
  // the vendor sees a live-monitoring notice (transparency / KVKK).
  useEffect(() => {
    let stop = false;
    const poll = async () => {
      try {
        const res = await fetch(`/api/gateway/${siteId}/watch-status`, { cache: "no-store" });
        if (res.ok) {
          const s = (await res.json()) as { watching: boolean; controlHeld: boolean };
          if (!stop) { setWatching(s.watching); setControlHeld(s.controlHeld); }
        }
      } catch {
        /* ignore */
      }
    };
    void poll();
    const t = setInterval(poll, 2000);
    return () => { stop = true; clearInterval(t); };
  }, [siteId]);

  useEffect(() => {
    // Keep our branded splash up until the embedded KasmVNC client actually
    // CONNECTS — it adds `noVNC_connected` to its documentElement then. Dismissing
    // on iframe onLoad instead (document ready, but not yet connected) would
    // uncover KasmVNC's own "connecting" splash underneath. The iframe is
    // same-origin (/kasm-tunnel is under the manager host), so we can read its
    // document. A 20 s fallback guarantees we never trap the vendor behind it.
    const isConnected = () => {
      try {
        return !!frameRef.current?.contentDocument?.documentElement.classList.contains("noVNC_connected");
      } catch {
        return false;
      }
    };
    const poll = window.setInterval(() => {
      if (isConnected()) { window.clearInterval(poll); setReady(true); setConnectedAt((t) => t ?? Date.now()); }
    }, 250);
    const fallback = window.setTimeout(() => { window.clearInterval(poll); setReady(true); }, 20000);
    return () => { window.clearInterval(poll); window.clearTimeout(fallback); };
  }, [gen]);

  return (
    <>
      {dims && (
        <iframe
          ref={frameRef}
          title="Isolated browser"
          key={gen}
          src={`/kasm-tunnel/?site=${siteId}&w=${dims.w}&h=${dims.h}&${KASM_PARAMS}${QUALITY_PARAMS[quality]}`}
          style={{ position: "fixed", inset: 0, width: "100vw", height: "100vh", border: 0 }}
          allow="clipboard-read; clipboard-write"
        />
      )}
      {/* Drag catcher: the iframe would swallow drag events, so while files are being
          dragged a transparent layer above it owns the drop. */}
      <div
        style={{ position: "fixed", inset: 0, zIndex: dropState === "idle" ? -1 : 36, pointerEvents: dropState === "idle" ? "none" : "auto" }}
        onDragOver={(e) => e.preventDefault()} onDragLeave={onDragLeave} onDrop={onDrop}
      />
      <div style={{ position: "fixed", inset: 0, zIndex: 35, pointerEvents: "none" }} onDragEnter={onDragEnter} />
      {ready && dims && (
        <>
          {canUpload && <input ref={fileRef} type="file" style={{ display: "none" }} onChange={onPick} />}
          <SessionPanel
            siteName={siteName}
            mode="Isolated browser"
            connectedAt={connectedAt}
            quick={[
              { key: "fs", icon: "fullscreen", label: fs ? "Exit full screen" : "Full screen", active: fs, onClick: toggleFs },
              { key: "up", icon: "upload", label: "Upload", disabled: !canUpload, onClick: () => fileRef.current?.click() },
              { key: "kbd", icon: "keyboard", label: "Keyboard", onClick: () => document.querySelector<HTMLButtonElement>(".osk-handle")?.click() },
            ]}
            sections={[
              { title: "Session", items: [
                { key: "files", icon: canUpload || canDownload ? "upload" : "block", label: "File transfer", sub: !canUpload && !canDownload ? "Disabled for this resource by policy" : `${canUpload ? "Upload allowed (drop files on the screen)" : "Upload blocked"} · ${canDownload ? "download allowed" : "download blocked"}`, tone: canUpload || canDownload ? "ok" : "muted", onClick: canUpload ? () => fileRef.current?.click() : undefined, chevron: canUpload },
                ...(canDownload ? [{ key: "downloads", icon: "download" as const, label: "Downloads", sub: downloads.length ? `${downloads.length} file${downloads.length === 1 ? "" : "s"} ready — listed at the bottom left` : "Files the browser downloads appear here", tone: (downloads.length ? "ok" : "muted") as "ok" | "muted" }] : []),
                { key: "clipboard", icon: "clipboard", label: "Clipboard", sub: "Seamless copy & paste, as allowed by policy", tone: "ok" },
                { key: "rec", icon: "record", label: "Session recording", sub: recorded ? "This session is recorded for security & compliance" : "Not recorded", tone: recorded ? "danger" : "muted" },
                { key: "quality", icon: "gauge", label: "Streaming quality", sub: `${QUALITY_LABEL[quality]} — tap to change (reopens the browser)`, tone: "default", onClick: cycleQuality, chevron: true },
                { key: "iso", icon: "shield", label: "Isolation", sub: "The app runs in a throwaway browser inside the customer network; only pixels reach you", tone: "muted" },
              ] },
            ]}
            leave={{ label: "Leave session", sub: "Close the isolated browser and return to My access", onClick: () => { window.location.href = "/access"; } }}
          />
          <OnScreenKeyboard sendKey={sendKeysym} />
          <FirstTips siteId={siteId} tips={[...(canUpload ? ["Drag files onto the screen to upload"] : []), "Controls: top-left tab", "Full screen fits the app exactly"]} />
        </>
      )}
      <RecordingNotice active={recorded && ready} />
      <MonitorNotice watching={watching} controlHeld={controlHeld} />
      <DropOverlay state={dropState} siteName={siteName} />
      <SessionToast toast={toast} />
      {ready && dims && canDownload && downloads.length > 0 && (
        <div className="ss-downloads">
          <div className="ss-downloads-title">Downloads ({downloads.length})</div>
          {downloads.map((d) => (
            <a key={d.name} href={`/api/isolated/files/download?site=${siteId}&name=${encodeURIComponent(d.name)}`} download={d.name} className="ss-downloads-item">↓ {d.name}</a>
          ))}
        </div>
      )}
      {(!ready || !dims) && <ConnectSplash siteName={siteName} />}
    </>
  );
}
