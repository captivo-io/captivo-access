import { describe, it, expect } from "vitest";
import { assembleKeyEvents } from "../assemble-keys";

describe("assembleKeyEvents", () => {
  it("reads newline-delimited batches and orders by time", () => {
    const raw =
      '[{"atMs":200,"kind":"command","text":"ls"}]\n' +
      '[{"atMs":100,"kind":"command","text":"cd /etc"}]\n';
    const got = assembleKeyEvents(raw);
    expect(got.map((e) => e.text)).toEqual(["cd /etc", "ls"]);
  });

  it("NEVER returns masked text", () => {
    // A masked line is a password prompt. The connector's search refuses to match it;
    // this is the same rule on the way out, so neither path can leak it.
    const raw = '[{"atMs":1,"kind":"text","text":"hunter2","masked":true}]\n';
    const got = assembleKeyEvents(raw);
    expect(got[0].masked).toBe(true);
    expect(got[0].text).not.toContain("hunter2");
    expect(got[0].text).toBe("••••");
  });

  it("skips a corrupt batch instead of losing the timeline", () => {
    const raw = '[{"atMs":1,"text":"a"}]\nnot json\n[{"atMs":2,"text":"b"}]\n';
    expect(assembleKeyEvents(raw).map((e) => e.text)).toEqual(["a", "b"]);
  });

  it("normalises an unexpected kind rather than trusting it", () => {
    const raw = '[{"atMs":1,"kind":"../../etc/passwd","text":"x"}]\n';
    expect(assembleKeyEvents(raw)[0].kind).toBe("text");
  });

  it("returns nothing for empty input", () => {
    expect(assembleKeyEvents("")).toEqual([]);
  });
});
