import { describe, it, expect } from "vitest";
import { parseAsciicast, parseSize, skipIdle, stateAt, termMarks } from "./asciicast";

const rec = [
  JSON.stringify({ version: 2, width: 120, height: 40, timestamp: 1 }),
  JSON.stringify([0.1, "m", "Shell opened"]),
  JSON.stringify([0.5, "o", "ops@box:~$ "]),
  JSON.stringify([1.25, "o", "ls\r\n"]),
  JSON.stringify([2, "r", "100x30"]),
  JSON.stringify([30, "m", "$ uptime"]),
  JSON.stringify([30.2, "o", "up 3 days\n"]),
  JSON.stringify([31, "m", "Session ended"]),
  '[31.5, "o", "cut sh', // the last line of a session that ended mid-write
].join("\n");

describe("asciicast", () => {
  it("reads the header and the events, and skips a broken line", () => {
    const r = parseAsciicast(rec);
    expect([r.cols, r.rows]).toEqual([120, 40]);
    expect(r.events).toHaveLength(7);
    expect(r.lengthMs).toBe(31_000);
    expect(r.events[2]).toEqual({ atMs: 1250, code: "o", data: "ls\r\n" });
  });
  it("rebuilds what the terminal shows at a moment", () => {
    const r = parseAsciicast(rec);
    expect(stateAt(r, 1300)).toEqual({ cols: 120, rows: 40, output: "ops@box:~$ ls\r\n", next: 3 });
    expect(stateAt(r, 2500)).toMatchObject({ cols: 100, rows: 30 });
    expect(stateAt(r, 0).output).toBe("");
  });
  it("lists the marked moments", () => {
    expect(termMarks(parseAsciicast(rec))).toEqual([{ atMs: 100, text: "Shell opened" }, { atMs: 30_000, text: "$ uptime" }]);
  });
  it("skips a quiet stretch to just before the next event", () => {
    const r = parseAsciicast(rec);
    const { next } = stateAt(r, 2500);
    expect(skipIdle(r, next, 2500, 3000)).toBe(29_500);
    expect(skipIdle(r, 1, 300, 3000)).toBe(300);
  });
  it("reads sizes", () => {
    expect(parseSize("80x24")).toEqual([80, 24]);
    expect(parseSize("0x24")).toBeNull();
    expect(parseSize("big")).toBeNull();
  });
});
