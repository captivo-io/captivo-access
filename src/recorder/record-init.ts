import { record } from "rrweb";

type RRWebEvent = { type?: number };

(() => {
  try {
    const KEY_STORE = "__captivo_rec_key";
    const SEQ_STORE = "__captivo_rec_seq";
    const newId = () => crypto.randomUUID?.() ?? String(Date.now()) + Math.random();

    // Persist key + seq per browser tab so a full navigation (redirect,
    // meta-refresh, SPA hard nav) continues ONE recording instead of starting a
    // fresh, snapshot-orphaned one. sessionStorage is per-tab and cleared when
    // the tab closes — exactly one vendor visit. Falls back to an in-memory key
    // when storage is unavailable (private mode). Note: a duplicated tab
    // inherits a copy of sessionStorage, so both tabs would share this key+seq;
    // that only interleaves chunks (never blanks a replay) and is an accepted
    // consequence of the per-tab design.
    let key: string;
    let seq: number;
    try {
      key = sessionStorage.getItem(KEY_STORE) ?? newId();
      sessionStorage.setItem(KEY_STORE, key);
      seq = Number(sessionStorage.getItem(SEQ_STORE) ?? "0") || 0;
    } catch {
      key = newId();
      seq = 0;
    }
    const persistSeq = (n: number) => {
      try { sessionStorage.setItem(SEQ_STORE, String(n)); } catch { /* ignore */ }
    };

    // Visible, always-on notice that the session is being recorded
    // (transparency / consent). Same look as the gateway/isolated sessions: a
    // branded card for the first seconds, then a compact "REC" pill. Injected
    // only when the recorder actually runs and non-interactive, so it can never
    // block the app. Must never break the app, hence the guard.
    try {
      const MARK = '<svg width="20" height="20" viewBox="0 0 100 100" fill="none" aria-hidden="true"><defs><linearGradient id="carec" x1="16" y1="12" x2="84" y2="88" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#2EE6C9"/><stop offset="0.52" stop-color="#12B5B0"/><stop offset="1" stop-color="#0B7D73"/></linearGradient></defs><path d="M77.98 67.49 A33 33 0 1 1 77.98 32.51" stroke="url(#carec)" stroke-width="7.5" stroke-linecap="round"/><path fill-rule="evenodd" clip-rule="evenodd" d="M83 41.6 a8.4 8.4 0 1 1 0 16.8 a8.4 8.4 0 0 1 0 -16.8 Z M83 44.8 a3.1 3.1 0 0 0 -1.25 5.94 l -0.85 4.06 h 4.2 l -0.85 -4.06 A3.1 3.1 0 0 0 83 44.8 Z" fill="url(#carec)"/></svg>';
      const FONT = "system-ui,-apple-system,'Segoe UI',sans-serif";
      const badge = document.createElement("div");
      const base = "position:fixed;z-index:2147483647;display:flex;align-items:center;gap:10px;background:rgba(11,20,36,.93);color:#fff;border:1px solid rgba(255,107,122,.35);box-shadow:0 8px 24px rgba(0,0,0,.35);pointer-events:none;font-family:" + FONT + ";transition:all .25s ease;";
      const dot = '<span style="width:9px;height:9px;border-radius:50%;background:#ff4d4f;flex:0 0 auto;box-shadow:0 0 0 3px rgba(255,77,79,.25)"></span>';
      const expanded = () => {
        badge.setAttribute("style", base + "top:16px;left:50%;transform:translateX(-50%);border-radius:14px;padding:10px 16px 10px 14px;");
        badge.innerHTML = dot + MARK + '<span style="display:flex;flex-direction:column;gap:2px"><b style="font:600 13px/1.2 ' + FONT + '">This session is being recorded</b><span style="font:400 11px/1.2 ' + FONT + ';color:#8ea0ba">Captivo Access · security &amp; compliance</span></span>';
      };
      const compact = () => {
        badge.setAttribute("style", base + "bottom:12px;left:12px;border-radius:999px;padding:6px 12px 6px 10px;");
        badge.innerHTML = dot + '<span style="font:700 11px/1 ui-monospace,Menlo,monospace;letter-spacing:.12em;color:#ff8a8f">REC</span>';
      };
      // Show the full card once per tab (first page of the session), the pill after.
      let seen = false;
      try { seen = sessionStorage.getItem("__captivo_rec_seen") === "1"; sessionStorage.setItem("__captivo_rec_seen", "1"); } catch { /* ignore */ }
      if (seen) compact(); else { expanded(); setTimeout(compact, 6000); }
      const mount = () => { if (document.body) document.body.appendChild(badge); };
      if (document.body) mount(); else addEventListener("DOMContentLoaded", mount);
    } catch { /* never break the app */ }

    let buf: RRWebEvent[] = [];

    // In-session send: a plain fetch has NO body-size cap. sendBeacon and
    // keepalive-fetch are both hard-limited to 64 KB by the browser, which
    // silently dropped the (large) FullSnapshot batch — leaving an
    // unreplayable, snapshot-less recording. The page is alive here, so a
    // normal fetch completes.
    const send = (batch: RRWebEvent[], s: number) => {
      const body = JSON.stringify({ recordingKey: key, seq: s, events: batch });
      try {
        // .catch swallows async rejections too (a bare `void fetch` would let a
        // network-blip rejection surface as an unhandledrejection in the app).
        fetch("/__captivo/rec", {
          method: "POST",
          body,
          headers: { "content-type": "application/json" },
        }).catch(() => {});
      } catch { /* recording must never break the app */ }
    };

    // Terminal send (tab hidden / unloading): the page may die before a normal
    // fetch resolves, so use sendBeacon (survives unload) with a keepalive
    // fallback. Both cap at 64 KB, but the snapshot and periodic batches have
    // already gone out via plain fetch; the tail is only recent incrementals.
    const sendFinal = (batch: RRWebEvent[], s: number) => {
      const body = JSON.stringify({ recordingKey: key, seq: s, events: batch });
      try {
        const blob = new Blob([body], { type: "application/json" });
        if (!navigator.sendBeacon("/__captivo/rec", blob)) {
          fetch("/__captivo/rec", {
            method: "POST",
            body,
            headers: { "content-type": "application/json" },
            keepalive: true,
          }).catch(() => {});
        }
      } catch { /* fail silent */ }
    };

    const flush = (terminal = false) => {
      if (buf.length === 0) return;
      const batch = buf;
      buf = [];
      const s = seq++;
      persistSeq(seq);
      if (terminal) sendFinal(batch, s); else send(batch, s);
    };

    record({
      emit: (e: RRWebEvent) => {
        buf.push(e);
        // Flush the FullSnapshot (type 2) immediately via plain fetch so the
        // replay anchor is persisted right away, regardless of batching.
        if (e.type === 2 || buf.length >= 50) flush();
      },
      maskAllInputs: true, // conservative: never capture typed input values
    });
    setInterval(() => flush(), 5000);
    addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") flush(true);
    });
    addEventListener("pagehide", () => flush(true));
  } catch {
    /* fail silent */
  }
})();
