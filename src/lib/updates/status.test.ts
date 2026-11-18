import { describe, it, expect } from "vitest";
import { updateStatus, checkIsStale, connectorVersionState, CHECK_STALE_MS } from "./status";

describe("updateStatus", () => {
  it("compares the running version with the latest release", () => {
    expect(updateStatus("2.29.0", "2.29.0")).toBe("current");
    expect(updateStatus("2.29.0", "v2.27.0")).toBe("ahead");
    expect(updateStatus("2.27.0", "2.29.0")).toBe("behind");
    expect(updateStatus("2.29.0", null)).toBe("unknown");
    expect(updateStatus("dev", "2.29.0")).toBe("unknown");
  });
});

describe("checkIsStale", () => {
  const now = Date.parse("2026-11-18T12:00:00Z");
  it("checks when on and nothing ran in the last day", () => {
    expect(checkIsStale(true, null, now)).toBe(true);
    expect(checkIsStale(true, new Date(now - CHECK_STALE_MS).toISOString(), now)).toBe(true);
    expect(checkIsStale(true, new Date(now - 60_000).toISOString(), now)).toBe(false);
    expect(checkIsStale(false, null, now)).toBe(false);
  });
});

describe("connectorVersionState", () => {
  it("uses the Connectors page's rule", () => {
    expect(connectorVersionState("2.22.0", "2.29.0")).toBe("outdated");
    expect(connectorVersionState("2.29.0", "2.29.0")).toBe("current");
    expect(connectorVersionState("2.30.0", "2.29.0")).toBe("current");
    expect(connectorVersionState(null, "2.29.0")).toBe("unknown");
  });
});
