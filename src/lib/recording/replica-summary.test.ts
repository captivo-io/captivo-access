import { describe, expect, it } from "vitest";
import { stalledText, summarizeReplicas } from "./replica-summary";
import { canHoldCopies, REPLICA_MIN_VERSION } from "./replica-version";

describe("group copies summary", () => {
  it("counts complete and copying, adds the bytes, and groups stalled reasons (a complete copy is never stalled)", () => {
    const s = summarizeReplicas([
      { state: "COMPLETE", lastError: null, _count: 5, bytes: 1000 },
      { state: "COPYING", lastError: null, _count: 2, bytes: 50 },
      { state: "COPYING", lastError: "waiting_for_video", _count: 1, bytes: 0 },
      { state: "PENDING", lastError: "waiting_for_video", _count: 2, bytes: 0 },
      { state: "COMPLETE", lastError: "copy_failed", _count: 1, bytes: 5 },
    ]);
    expect(s).toMatchObject({ complete: 6, copying: 5, bytes: 1055 });
    expect(s.stalled).toEqual([{ code: "waiting_for_video", count: 3 }]);
  });
  it("says each reason in words and never prints an unknown code", () => {
    expect(stalledText("waiting_for_video", 1)).toBe("1 recording: a remote-desktop session is copied as video, which its connector is still making");
    expect(stalledText("copy_failed", 3)).toContain("3 recordings");
    expect(stalledText("../etc/passwd", 2)).toBe("2 recordings: not moving");
  });
  it("knows which connectors can hold copies", () => {
    expect(REPLICA_MIN_VERSION).toBe("2.84.0");
    expect(canHoldCopies("2.84.0")).toBe(true);
    expect(canHoldCopies("2.90.1")).toBe(true);
    expect(canHoldCopies("2.83.1")).toBe(false);
    expect(canHoldCopies(null)).toBe(false);
    expect(canHoldCopies("dev")).toBe(false);
  });
});
