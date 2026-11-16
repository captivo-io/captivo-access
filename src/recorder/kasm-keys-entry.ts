/**
 * Content script of the isolated browser's keys extension
 * (kasm-browser/keys-ext). The capture and its masking are the web app
 * recorder's own (./keys), so both kinds of session mask the same fields the
 * same way. Times are sent absolute (start 0); the broker turns them into
 * offsets from the start of the session's video.
 */
import { installKeyCapture } from "./keys";

declare const chrome: { runtime: { sendMessage: (m: unknown) => void } };

const capture = installKeyCapture({
  start: 0,
  emit: (e) => {
    try { chrome.runtime.sendMessage({ k: e }); } catch { /* extension context gone */ }
  },
});
addEventListener("pagehide", () => capture.flush());
