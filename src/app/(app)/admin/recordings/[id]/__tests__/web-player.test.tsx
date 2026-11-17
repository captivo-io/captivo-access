// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";

// A stand-in for rrweb's Replayer with the parts the player uses: its own
// clock (offset + elapsed while playing) and the speed setting.
const lib = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const state = { r: null as null | any, now: 0 };
  class FakeReplayer {
    wrapper = document.createElement("div");
    iframe = Object.assign(document.createElement("iframe"), { width: "1280", height: "720" });
    handlers: Record<string, () => void> = {};
    offset = 0;
    startedAt: number | null = null;
    speed = 1;
    calls: string[] = [];
    constructor(_events: unknown, cfg: { root: HTMLElement }) {
      cfg.root.appendChild(this.wrapper);
      state.r = this;
    }
    on(e: string, h: () => void) { this.handlers[e] = h; return this; }
    setConfig(c: { speed?: number }) { if (c.speed) this.speed = c.speed; }
    getMetaData() { return { startTime: 0, endTime: 60_000, totalTime: 60_000 }; }
    getCurrentTime() { return this.offset + (this.startedAt === null ? 0 : (state.now - this.startedAt) * this.speed); }
    play(o = 0) { this.calls.push(`play ${o}`); this.offset = o; this.startedAt = state.now; }
    pause(o?: number) { this.calls.push(`pause ${o}`); this.offset = o ?? this.getCurrentTime(); this.startedAt = null; }
    destroy() {}
  }
  return { state, mod: { Replayer: FakeReplayer } };
});
vi.mock("rrweb", () => lib.mod);
vi.mock("rrweb-player/dist/style.css", () => ({}));
vi.mock("@/lib/recording/snapshot", () => ({ hasFullSnapshot: () => true }));

import { RecordingPlayer } from "../recording-player";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const q = <T extends Element>(s: string) => document.querySelector(s) as T;
const button = () => q<HTMLButtonElement>(".rec-controls .rec-play");
const clock = () => q<HTMLElement>(".rec-controls .rec-time").textContent;
const flush = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); });

describe("web-app recording player", () => {
  beforeEach(() => {
    document.body.innerHTML = "<div id=root></div>";
    lib.state.now = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => ({
      ok: true,
      json: async () => (String(url).endsWith("/events") ? { events: [{}, {}, {}] } : []),
    })));
  });

  it("shows the first frame with the shared controls, and plays with its own clock", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const root = createRoot(document.getElementById("root")!);
    await act(async () => root.render(<RecordingPlayer id="w1" />));
    await flush();
    expect(lib.state.r?.calls).toEqual(["pause 0"]);
    expect(button().textContent).toBe("Play");
    expect(clock()).toBe("0:00 / 1:00");

    await act(async () => button().click());
    expect(lib.state.r?.calls.at(-1)).toBe("play 0");
    lib.state.now = 12_000;
    await act(async () => { vi.advanceTimersByTime(300); });
    expect(clock()).toBe("0:12 / 1:00");
    vi.useRealTimers();
  });

  it("seeks while paused without starting, and changes speed", async () => {
    const root = createRoot(document.getElementById("root")!);
    await act(async () => root.render(<RecordingPlayer id="w1" />));
    await flush();
    const bar = q<HTMLInputElement>(".rec-controls .rec-seek");
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => { set.call(bar, "30000"); bar.dispatchEvent(new Event("input", { bubbles: true })); });
    expect(lib.state.r?.calls.at(-1)).toBe("pause 30000");
    expect(clock()).toBe("0:30 / 1:00");

    const sp = q<HTMLSelectElement>(".rec-controls .rec-speed");
    await act(async () => { sp.value = "8"; sp.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(lib.state.r?.speed).toBe(8);
  });

  it("scales the page to the stage", async () => {
    const root = createRoot(document.getElementById("root")!);
    Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get() { return 640; } });
    await act(async () => root.render(<RecordingPlayer id="w1" />));
    await flush();
    expect(lib.state.r?.wrapper.style.transform).toBe("scale(0.5)");
    expect(q<HTMLElement>(".rec-stage").style.height).toBe("360px");
    delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
  });
});
