import { describe, it, expect } from "vitest";
import { assembleEvents } from "../assemble";

describe("assembleEvents", () => {
  it("concatenates newline-delimited batches in order", () => {
    const raw = '[{"type":1}]\n[{"type":2},{"type":3}]\n';
    expect(assembleEvents(raw)).toEqual([{ type: 1 }, { type: 2 }, { type: 3 }]);
  });

  it("skips a corrupt batch instead of losing the whole replay", () => {
    // One bad line must not cost the rest: a recording is evidence, and a partial
    // replay is worth far more than an error page.
    const raw = '[{"type":1}]\nnot json at all\n[{"type":2}]\n';
    expect(assembleEvents(raw)).toEqual([{ type: 1 }, { type: 2 }]);
  });

  it("tolerates a missing trailing newline", () => {
    expect(assembleEvents('[{"type":9}]')).toEqual([{ type: 9 }]);
  });

  it("returns nothing for empty input rather than throwing", () => {
    expect(assembleEvents("")).toEqual([]);
    expect(assembleEvents(Buffer.alloc(0))).toEqual([]);
  });
});
