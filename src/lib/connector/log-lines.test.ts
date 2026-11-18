import { describe, it, expect } from "vitest";
import { collapseLines, logRows, parseLogLine } from "./log-lines";

describe("parseLogLine", () => {
  it("reads the connector's own format", () => {
    expect(parseLogLine("2026/11/18 13:39:56 INFO activity: 4835 requests total")).toEqual({ time: "13:39:56", level: "INFO", msg: "activity: 4835 requests total" });
    expect(parseLogLine("2026/11/18 13:40:01 ERROR upstream error: dial tcp 10.0.0.3:3389: i/o timeout").level).toBe("ERROR");
    expect(parseLogLine("2026/11/18 13:40:01 WARN probe slow").level).toBe("WARN");
  });
  it("reads guacd and broker styles", () => {
    expect(parseLogLine("guacd[7]: ERROR:\tConnection to 10.0.0.3 failed")).toEqual({ time: "", level: "ERROR", msg: "guacd[7]: Connection to 10.0.0.3 failed" });
    expect(parseLogLine("2026-11-18 12:00:01,123 [WARNING] token expired")).toEqual({ time: "12:00:01", level: "WARN", msg: "token expired" });
    expect(parseLogLine("2026-11-18T12:00:01.5Z notice: listening").level).toBe("INFO");
  });
  it("does not take a level from deep inside the message", () => {
    expect(parseLogLine("2026/11/18 13:39:56 INFO client closed after a long session without any error").level).toBe("INFO");
    expect(parseLogLine("plain line that mentions the word error much later on").level).toBe("INFO");
  });
});

describe("collapse and filter", () => {
  const raw = [
    "2026/11/18 10:00:00 WARN probe 10.0.0.3:3389 timeout",
    "2026/11/18 10:00:30 WARN probe 10.0.0.3:3389 timeout",
    "2026/11/18 10:01:00 WARN probe 10.0.0.3:3389 timeout",
    "2026/11/18 10:01:10 INFO tunnel up",
    "2026/11/18 10:01:20 ERROR dial failed",
  ];
  it("folds identical consecutive lines and keeps the newest time", () => {
    const rows = collapseLines(raw.map(parseLogLine));
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ count: 3, time: "10:01:00" });
  });
  it("filters by level and text", () => {
    expect(logRows(raw, "error", "").map((r) => r.msg)).toEqual(["dial failed"]);
    expect(logRows(raw, "warn", "")).toHaveLength(2);
    expect(logRows(raw, "all", "tunnel").map((r) => r.msg)).toEqual(["tunnel up"]);
  });
});
