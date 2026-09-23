/* eslint-disable @typescript-eslint/no-explicit-any */
import type { ClipboardCaps } from "@/lib/gateway/clipboard-caps";

export type PushResult = "pushed" | "unchanged" | "blocked" | "empty";

export interface ClipboardBridge {
  syncFromBrowser: () => void;
  pushLocal: (text: string) => PushResult;
  getRemoteText: () => string;
  // Whether the automatic browser→session sync (Clipboard API on focus) is
  // usable in this browser. False = permission denied / API unavailable; Ctrl+V
  // and the manual panel still work.
  autoSyncBlocked: () => boolean;
}

// Owns the text clipboard bridge between the browser and a guacd session.
// Installs client.onclipboard (remote → browser) and exposes helpers the
// session component drives: syncFromBrowser() on focus (browser → remote via
// the Clipboard API), pushLocal() from the paste gesture / manual panel.
// Direction is gated by caps; guacd enforces the same server-side.
export function createClipboardBridge(client: any, Guacamole: any, caps: ClipboardCaps, onSyncState?: (blocked: boolean) => void): ClipboardBridge {
  let remoteText = "";
  let lastPushed: string | null = null;
  let blocked = typeof navigator === "undefined" || !navigator.clipboard?.readText;
  const setBlocked = (b: boolean) => { if (b !== blocked) { blocked = b; onSyncState?.(b); } };

  // remote → browser
  client.onclipboard = (stream: any, mimetype: string) => {
    // Text-only: ignore non-text clipboard (e.g. image/png) rather than corrupt it.
    if (typeof mimetype === "string" && mimetype && !mimetype.startsWith("text/")) return;
    const reader = new Guacamole.StringReader(stream);
    let buf = "";
    reader.ontext = (t: string) => { buf += t; };
    reader.onend = () => {
      remoteText = buf;
      // What guacd holds now is what a paste would insert; don't re-push it.
      lastPushed = buf;
      if (caps.allowCopyOut && typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(remoteText).catch(() => { /* permission denied — panel is the fallback */ });
      }
    };
  };

  const pushLocal = (text: string): PushResult => {
    if (!caps.allowPasteIn) return "blocked";
    if (!text) return "empty";
    if (text === lastPushed) return "unchanged";
    const stream = client.createClipboardStream("text/plain");
    const writer = new Guacamole.StringWriter(stream);
    writer.sendText(text);
    writer.sendEnd();
    lastPushed = text;
    return "pushed";
  };

  const syncFromBrowser = () => {
    if (!caps.allowPasteIn || typeof navigator === "undefined" || !navigator.clipboard?.readText) return;
    navigator.clipboard.readText()
      .then((t) => { setBlocked(false); if (t) pushLocal(t); })
      .catch(() => { setBlocked(true); /* denied / unfocused — Ctrl+V + the panel cover it */ });
  };

  return { syncFromBrowser, pushLocal, getRemoteText: () => remoteText, autoSyncBlocked: () => blocked };
}
