import { describe, it, expect } from "vitest";
import { clockOf, downloadable, fileNameFor, humanBytes, protocolLabel, spanOf } from "./format";

describe("recording formatting", () => {
  it("labels the kind of session", () => {
    expect(protocolLabel({ format: "RRWEB", protocol: null })).toBe("WEB");
    expect(protocolLabel({ format: "VIDEO", protocol: "isolated" })).toBe("BROWSER");
    expect(protocolLabel({ format: "GUAC", protocol: "ssh" })).toBe("SSH");
  });
  it("offers a download only for video", () => {
    expect(downloadable({ id: "a", format: "GUAC", protocol: "rdp", videoReady: true })).toBe(true);
    expect(downloadable({ id: "a", format: "GUAC", protocol: "ssh", videoReady: false })).toBe(false);
    expect(downloadable({ id: "a", format: "RRWEB", protocol: null })).toBe(false);
  });
  it("formats lengths and sizes", () => {
    expect(clockOf(250_000)).toBe("4:10");
    expect(clockOf(3_727_000)).toBe("1:02:07");
    expect(spanOf(520_000)).toBe("8 min 40 s");
    expect(spanOf(7_500_000)).toBe("2 h 5 min");
    expect(humanBytes(143)).toBe("143 B");
    expect(humanBytes(4_404_019)).toBe("4.2 MB");
  });
  it("names a download after the resource and start", () => {
    expect(fileNameFor("WIN-SK / prod", "2026-11-17T20:05:14.000Z")).toBe("WIN-SK-prod-2026-11-17-20-05.webm");
  });
});
