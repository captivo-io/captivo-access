// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";

// The players themselves are tested on their own; here they only say which one
// is showing, and the instruction-stream one can be "touched".
vi.mock("../guac-recording-player", () => ({
  GuacRecordingPlayer: ({ onInteract }: { onInteract?: () => void }) => (
    <button type="button" id="guac" onClick={onInteract}>guac</button>
  ),
}));
vi.mock("../video-recording-player", () => ({
  VideoRecordingPlayer: ({ durationMs }: { durationMs: number }) => <div id="video">video {durationMs}</div>,
}));

import { PreparingRecording } from "../preparing-recording";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let status: { videoReady: boolean; reported: boolean; durationMs: number | null };
const q = (s: string) => document.querySelector(s);

async function mount() {
  const root = createRoot(document.getElementById("root")!);
  await act(async () => root.render(<PreparingRecording id="r1" estimatedMs={60_000} />));
}
const poll = () => act(async () => { await vi.advanceTimersByTimeAsync(4100); });

describe("an RDP recording whose video is being prepared", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = "<div id=root></div>";
    status = { videoReady: false, reported: false, durationMs: null };
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => status })));
  });
  afterEach(() => vi.useRealTimers());

  it("says so, plays meanwhile, and switches to the video by itself", async () => {
    await mount();
    expect(q(".rec-preparing")?.textContent).toContain("Preparing the video");
    expect(q("#guac")).not.toBeNull();
    await poll();
    expect(q("#video")).toBeNull();
    status = { videoReady: true, reported: true, durationMs: 73_800 };
    await poll();
    expect(q("#video")?.textContent).toBe("video 73800");
    expect(q(".rec-preparing")).toBeNull();
  });

  it("offers the switch instead when the reviewer has started watching", async () => {
    await mount();
    await act(async () => (q("#guac") as HTMLButtonElement).click());
    status = { videoReady: true, reported: true, durationMs: 73_800 };
    await poll();
    expect(q("#video")).toBeNull();
    const btn = q(".rec-preparing button") as HTMLButtonElement;
    expect(btn.textContent).toBe("Switch to the video");
    await act(async () => btn.click());
    expect(q("#video")).not.toBeNull();
  });

  it("drops the note when the connector kept the recording as it is", async () => {
    await mount();
    status = { videoReady: false, reported: true, durationMs: null };
    await poll();
    expect(q(".rec-preparing")).toBeNull();
    expect(q("#guac")).not.toBeNull();
    const calls = (fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
    await poll();
    expect((fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length, "polling stopped").toBe(calls);
  });
});
