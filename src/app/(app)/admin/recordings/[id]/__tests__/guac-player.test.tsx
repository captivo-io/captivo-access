// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";

// A stand-in for guacamole-common-js's SessionRecording with its real contract:
// play() only plays while frames remain, and the library pauses on its own when
// playback reaches the end of what has been loaded.
const lib = vi.hoisted(() => {
  const state = { rec: null as any };
  class SessionRecording {
    playing = false;
    onload: any; onprogress: any; onseek: any; onplay: any; onpause: any; onerror: any;
    plays = 0;
    pos = 0; // the last frame drawn
    dur = 0;
    constructor() { state.rec = this; }
    getPosition() { return this.pos; }
    getDisplay() { return { getElement: () => document.createElement("div"), getWidth: () => 0, getHeight: () => 0, scale() {}, onresize: null }; }
    getDuration() { return this.dur; }
    isPlaying() { return this.playing; }
    play() { this.plays++; if (!this.playing) { this.playing = true; this.onplay?.(); } }
    pause() { if (this.playing) { this.playing = false; this.onpause?.(); } }
    seek(ms: number, cb: () => void) { const was = this.playing; this.pause(); this.pos = ms; cb(); if (was) this.play(); }
  }
  class StaticHTTPTunnel { connect() {} }
  return { state, mod: { default: { SessionRecording, StaticHTTPTunnel } } };
});
vi.mock("guacamole-common-js", () => lib.mod);

import { GuacRecordingPlayer } from "../guac-recording-player";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const button = () => document.querySelector(".guac-recording-controls button") as HTMLButtonElement;
const tick = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

describe("guac recording player: plays while the recording downloads", () => {
  beforeEach(() => {
    document.body.innerHTML = "<div id=root></div>";
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => [] })));
  });

  it("offers Play with the first frames, waits when it catches up, resumes as data arrives", async () => {
    const root = createRoot(document.getElementById("root")!);
    await act(async () => root.render(<GuacRecordingPlayer recordingId="r1" />));
    await tick();
    const rec = lib.state.rec;
    expect(button().textContent).toBe("Loading…");
    expect(button().disabled).toBe(true);

    await act(async () => rec.onprogress(5_000));
    expect(button().textContent).toBe("Play");
    expect(button().disabled).toBe(false);

    await act(async () => button().click());
    expect(button().textContent).toBe("Pause");

    // Playback reaches the end of what is loaded: the library pauses itself.
    await act(async () => rec.pause());
    expect(button().textContent).toBe("Buffering…");

    // More arrives: playback goes on without another click.
    const before = rec.plays;
    await act(async () => rec.onprogress(9_000));
    expect(rec.plays).toBe(before + 1);
    expect(button().textContent).toBe("Pause");

    // A seek pauses and resumes by itself; that is not a stall or a stop.
    await act(async () => rec.seek(2_000, () => {}));
    expect(button().textContent).toBe("Pause");

    // The user pauses: new data must not restart playback.
    await act(async () => button().click());
    expect(button().textContent).toBe("Play");
    const paused = rec.plays;
    await act(async () => rec.onprogress(12_000));
    expect(rec.plays).toBe(paused);
    root.unmount();
  });

  it("after the whole file is in, the end of playback is the end", async () => {
    const root = createRoot(document.getElementById("root")!);
    await act(async () => root.render(<GuacRecordingPlayer recordingId="r2" />));
    await tick();
    const rec = lib.state.rec;
    await act(async () => rec.onprogress(3_000));
    await act(async () => button().click());
    await act(async () => rec.onload());
    await act(async () => rec.pause());
    expect(button().textContent).toBe("Play");
    root.unmount();
  });
});

const seekBar = () => document.querySelector(".guac-recording-controls input") as HTMLInputElement;
// Set a range input's value the way a drag does, so React's onChange sees it.
const drag = (v: number) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(seekBar(), String(v));
  seekBar().dispatchEvent(new Event("input", { bubbles: true }));
};
const clock = () => (document.querySelector(".guac-recording-controls .cell-sub") as HTMLElement).textContent;

describe("guac recording player: clock and bar", () => {
  beforeEach(() => {
    document.body.innerHTML = "<div id=root></div>";
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => [] })));
  });

  it("the clock runs through a still stretch instead of stopping and jumping", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "performance"] });
    const root = createRoot(document.getElementById("root")!);
    await act(async () => root.render(<GuacRecordingPlayer recordingId="r3" />));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    await vi.waitFor(() => expect(lib.state.rec?.onprogress).toBeTypeOf("function"));
    const rec = lib.state.rec;
    await act(async () => rec.onprogress(600_000));
    await act(async () => button().click());
    // A frame at 9:10, then nothing drawn for a while.
    await act(async () => rec.onseek(550_000));
    await act(async () => { vi.advanceTimersByTime(12_000); });
    expect(clock()).toMatch(/^9:22 /);
    // The next frame lands where the clock already is.
    await act(async () => rec.onseek(580_000));
    expect(clock()).toMatch(/^9:40 /);
    vi.useRealTimers();
    root.unmount();
  });

  it("while loading, the bar spans the expected length so the thumb never slides back", async () => {
    const root = createRoot(document.getElementById("root")!);
    await act(async () => root.render(<GuacRecordingPlayer recordingId="r4" estimatedMs={700_000} />));
    await tick();
    const rec = lib.state.rec;
    await act(async () => rec.onprogress(100_000));
    expect(seekBar().max).toBe("700000");
    await act(async () => rec.onprogress(400_000));
    expect(seekBar().max).toBe("700000");
    expect(seekBar().style.getPropertyValue("--loaded")).toMatch(/^57\./);
    // Fully loaded: the real length.
    rec.dur = 690_000;
    await act(async () => rec.onload());
    expect(seekBar().max).toBe("690000");
    root.unmount();
  });

  it("a seek shows the target, not the replay from the keyframe, and stops at what is loaded", async () => {
    const root = createRoot(document.getElementById("root")!);
    await act(async () => root.render(<GuacRecordingPlayer recordingId="r5" estimatedMs={700_000} />));
    await tick();
    const rec = lib.state.rec;
    await act(async () => rec.onprogress(300_000));
    let done: () => void = () => {};
    rec.seek = (ms: number, cb: () => void) => { rec.pos = ms; done = cb; };
    await act(async () => drag(200_000));
    // The library replays from an earlier keyframe; those steps do not move the bar.
    await act(async () => rec.onseek(170_000));
    expect(seekBar().value).toBe("200000");
    await act(async () => done());
    expect(seekBar().value).toBe("200000");
    // Past what is loaded: the end of the loaded part.
    await act(async () => drag(650_000));
    expect(rec.pos).toBe(300_000);
    root.unmount();
  });
});
