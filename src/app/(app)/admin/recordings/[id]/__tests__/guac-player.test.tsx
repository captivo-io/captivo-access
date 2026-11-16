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
    constructor() { state.rec = this; }
    getDisplay() { return { getElement: () => document.createElement("div"), getWidth: () => 0, getHeight: () => 0, scale() {}, onresize: null }; }
    getDuration() { return 0; }
    isPlaying() { return this.playing; }
    play() { this.plays++; if (!this.playing) { this.playing = true; this.onplay?.(); } }
    pause() { if (this.playing) { this.playing = false; this.onpause?.(); } }
    seek(_ms: number, cb: () => void) { const was = this.playing; this.pause(); cb(); if (was) this.play(); }
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
