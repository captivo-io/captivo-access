import { describe, expect, it } from "vitest";
import { ago, duration, latency, maskIp, uptimePct } from "./connectors-view";

describe("connector card formatting", () => {
  it("masks the public address down to a hint", () => {
    expect(maskIp("85.105.12.4:51234")).toBe("85.105.•••.•••");
    expect(maskIp("[2a02:4780:1:2::5]:443")).toBe("2a02:4780:•••");
  });
  it("reads ages and durations plainly", () => {
    expect(ago(10_000)).toBe("just now");
    expect(ago(5 * 60_000)).toBe("5m ago");
    expect(duration(26 * 60)).toBe("26m");
    expect(duration(3 * 86400 + 4 * 3600)).toBe("3d 4h");
  });
  it("shows sub-10 ms latency with a decimal", () => {
    expect(latency(0.84)).toBe("0.8 ms");
    expect(latency(18.4)).toBe("18 ms");
  });
  it("never rounds a short outage up to 100%", () => {
    expect(uptimePct(100)).toBe("100%");
    expect(uptimePct(99.94)).toBe("99.94%");
  });
});
