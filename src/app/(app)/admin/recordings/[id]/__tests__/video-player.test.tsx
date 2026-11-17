// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { VideoRecordingPlayer } from "../video-recording-player";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const q = <T extends Element>(s: string) => document.querySelector(s) as T;
const video = () => q<HTMLVideoElement>("video");
const button = () => q<HTMLButtonElement>(".rec-controls .rec-play");
const clock = () => q<HTMLElement>(".rec-controls .rec-time").textContent;
const speedBtn = (v: string) => q<HTMLButtonElement>(`.rec-controls .rec-speed [data-speed="${v}"]`);
const seekBar = () => q<HTMLInputElement>(".rec-controls .rec-seek");

// jsdom's media element has no engine: give it the state a browser would and
// fire the events a browser fires.
function fakeMedia(v: HTMLVideoElement, durationSec: number) {
  let t = 0;
  let paused = true;
  Object.defineProperty(v, "duration", { configurable: true, get: () => durationSec });
  Object.defineProperty(v, "currentTime", {
    configurable: true,
    get: () => t,
    set: (x: number) => { t = x; v.dispatchEvent(new Event("seeked")); },
  });
  Object.defineProperty(v, "paused", { configurable: true, get: () => paused });
  Object.defineProperty(v, "buffered", {
    configurable: true,
    get: () => ({ length: 1, start: () => 0, end: () => Math.min(durationSec, t + 30) }),
  });
  v.play = vi.fn(async () => { paused = false; v.dispatchEvent(new Event("play")); });
  v.pause = vi.fn(() => { paused = true; v.dispatchEvent(new Event("pause")); });
}

async function mount(props: { durationMs?: number } = {}, durationSec = 731) {
  const root = createRoot(document.getElementById("root")!);
  await act(async () => root.render(<VideoRecordingPlayer id="r1" {...props} />));
  fakeMedia(video(), durationSec);
  await act(async () => { video().dispatchEvent(new Event("loadedmetadata")); });
  return root;
}

function setRange(el: HTMLInputElement, value: number) {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  set.call(el, String(value));
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("video recording player", () => {
  beforeEach(() => {
    document.body.innerHTML = "<div id=root></div>";
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => [] })));
  });

  it("streams from the video route with the shared controls, no native ones", async () => {
    await mount();
    expect(video().getAttribute("src")).toBe("/api/admin/recordings/r1/video");
    expect(video().hasAttribute("controls")).toBe(false);
    expect(button().textContent).toBe("Play");
    expect(clock()).toBe("0:00 / 12:11");
  });

  it("plays, pauses, and follows the clock", async () => {
    await mount();
    await act(async () => button().click());
    expect(video().play).toHaveBeenCalled();
    expect(button().textContent).toBe("Pause");
    await act(async () => {
      video().currentTime = 65;
      video().dispatchEvent(new Event("timeupdate"));
    });
    expect(clock()).toBe("1:05 / 12:11");
    await act(async () => button().click());
    expect(video().pause).toHaveBeenCalled();
    expect(button().textContent).toBe("Play");
  });

  it("seeks anywhere at once, past what is buffered too", async () => {
    await mount();
    await act(async () => setRange(seekBar(), 600_000));
    expect(video().currentTime).toBe(600);
    expect(clock()).toBe("10:00 / 12:11");
  });

  it("changes speed", async () => {
    await mount();
    await act(async () => {
      speedBtn("4").click();
    });
    expect(video().playbackRate).toBe(4);
  });

  it("steps with the arrow keys and plays with space", async () => {
    await mount();
    const player = q<HTMLElement>(".rec-player");
    await act(async () => { player.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })); });
    expect(video().currentTime).toBe(5);
    await act(async () => { player.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true })); });
    expect(video().play).toHaveBeenCalled();
  });

  it("shows buffering while the browser waits for data", async () => {
    await mount();
    await act(async () => button().click());
    await act(async () => { video().dispatchEvent(new Event("waiting")); });
    expect(button().textContent).toBe("Buffering…");
    await act(async () => { video().dispatchEvent(new Event("playing")); });
    expect(button().textContent).toBe("Pause");
  });

  it("uses the measured length when the file states none (a cut-off video)", async () => {
    await mount({ durationMs: 95_000 }, Infinity);
    expect(clock()).toBe("0:00 / 1:35");
  });

  it("says when the recording cannot be loaded", async () => {
    await mount();
    await act(async () => { video().dispatchEvent(new Event("error")); });
    expect(document.body.textContent).toContain("Couldn't load this recording");
  });

  it("is playable when the metadata arrived before it was listening", async () => {
    // A fast or cached answer: the element has its metadata by the time the
    // player's effect runs, so no loadedmetadata event will come.
    const desc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "readyState");
    Object.defineProperty(HTMLMediaElement.prototype, "readyState", { configurable: true, get: () => 4 });
    try {
      const root = createRoot(document.getElementById("root")!);
      await act(async () => root.render(<VideoRecordingPlayer id="r1" durationMs={60_000} />));
      expect(button().disabled).toBe(false);
      expect(button().textContent).toBe("Play");
      expect(clock()).toBe("0:00 / 1:00");
    } finally {
      if (desc) Object.defineProperty(HTMLMediaElement.prototype, "readyState", desc);
    }
  });
});
