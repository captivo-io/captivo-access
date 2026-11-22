import { describe, it, expect } from "vitest";
import { buildTimeline, currentEventIndex } from "./timeline";

describe("buildTimeline", () => {
  it("frames the events with the session's start and end, in time order", () => {
    const t = buildTimeline({
      totalMs: 60_000,
      terminal: true,
      keys: [{ atMs: 30_000, kind: "command", text: "sudo systemctl status nftables", masked: false }, { atMs: 6000, kind: "text", text: "secret", masked: true }],
      transfers: [{ atMs: 20_000, text: "Uploaded rules.conf · 2.4 MB" }],
    });
    expect(t.map((e) => [e.atMs, e.tone, e.text])).toEqual([
      [0, "muted", "Session started"],
      [6000, "text", "Hidden input (password prompt)"],
      [20_000, "file", "Uploaded rules.conf · 2.4 MB"],
      [30_000, "command", "sudo systemctl status nftables"],
      [60_000, "muted", "Session ended"],
    ]);
    expect(t[3].command).toBe(true);
  });
  it("shows typed text outside a terminal as text, page loads as navigation, and drops blank input", () => {
    const t = buildTimeline({ totalMs: 10_000, terminal: false, keys: [{ atMs: 1000, kind: "command", text: "  ", masked: false }, { atMs: 2000, kind: "command", text: "hello", masked: false }], navs: [{ atMs: 3000, text: "/settings" }] });
    expect(t.map((e) => e.tone)).toEqual(["muted", "text", "nav", "muted"]);
    expect(t[2].text).toBe("Opened /settings");
  });
  it("keeps events inside the recording", () => {
    const t = buildTimeline({ totalMs: 5000, terminal: true, transfers: [{ atMs: 9000, text: "late" }] });
    expect(t[1].atMs).toBe(5000);
  });
});

describe("currentEventIndex", () => {
  const ev = buildTimeline({ totalMs: 10_000, terminal: true, transfers: [{ atMs: 4000, text: "f" }] });
  it("is the last event at or before the playhead", () => {
    expect(currentEventIndex(ev, 0)).toBe(0);
    expect(currentEventIndex(ev, 3999)).toBe(1);
    expect(currentEventIndex(ev, 5000)).toBe(1);
    expect(currentEventIndex(ev, 10_000)).toBe(2);
  });
});

describe("buildTimeline with a native SSH session's marks", () => {
  it("lists refusals and SFTP changes, and a command once", () => {
    const ev = buildTimeline({
      totalMs: 60_000, terminal: true,
      keys: [{ atMs: 5_000, kind: "command", text: "uptime", masked: false }],
      marks: [
        { atMs: 5_000, text: "$ uptime" },
        { atMs: 6_000, text: "$ df -h" },
        { atMs: 7_000, text: "Port forwarding refused: this session is recorded" },
        { atMs: 8_000, text: "SFTP remove: /tmp/x" },
        { atMs: 9_000, text: "Uploaded /tmp/y (sftp, 3 bytes)" },
      ],
    });
    expect(ev.map((e) => `${e.tone}:${e.text}`)).toEqual([
      "muted:Session started", "command:uptime", "command:df -h",
      "text:Port forwarding refused: this session is recorded", "file:SFTP remove: /tmp/x", "muted:Session ended",
    ]);
  });
});
