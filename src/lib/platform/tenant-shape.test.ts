import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseLimits, parseCapabilities, limitsForStorage, withinLimit, trialState, formatBytes, isPlan, PLANS } from "./tenant-shape";

describe("parseLimits", () => {
  it("keeps positive integers, coerces numeric strings, drops junk", () => {
    expect(parseLimits({ maxUsers: 10, maxSites: "5", maxConnectors: 0, maxRecordingRetentionDays: -1, bogus: 3 })).toEqual({ maxUsers: 10, maxSites: 5 });
    expect(parseLimits(null)).toEqual({});
    expect(parseLimits("x")).toEqual({});
    expect(parseLimits({ maxUsers: "" })).toEqual({});
  });
  it("stores null when empty", () => {
    expect(limitsForStorage({})).toBeNull();
    expect(limitsForStorage({ maxUsers: 1 })).toEqual({ maxUsers: 1 });
  });
});

describe("parseCapabilities", () => {
  it("keeps only booleans for known keys", () => {
    expect(parseCapabilities({ recording: false, vault: true, isolated: "yes", nope: true })).toEqual({ recording: false, vault: true });
  });
});

describe("withinLimit / trialState / formatBytes / isPlan", () => {
  it("withinLimit", () => {
    expect(withinLimit({}, "maxUsers", 999)).toBe(true);
    expect(withinLimit({ maxUsers: 3 }, "maxUsers", 2)).toBe(true);
    expect(withinLimit({ maxUsers: 3 }, "maxUsers", 3)).toBe(false);
  });
  it("trialState", () => {
    const now = new Date("2026-09-10T00:00:00Z");
    expect(trialState("standard", null, now)).toBe("none");
    expect(trialState("trial", null, now)).toBe("active");
    expect(trialState("trial", new Date("2026-09-09T00:00:00Z"), now)).toBe("expired");
    expect(trialState("trial", new Date("2026-09-13T00:00:00Z"), now)).toBe("ending_soon");
    expect(trialState("trial", new Date("2026-10-13T00:00:00Z"), now)).toBe("active");
  });
  it("formatBytes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(5 * 1024 * 1024 * 1024)).toBe("5.0 GB");
  });
  it("isPlan", () => {
    expect(isPlan("trial")).toBe(true);
    expect(isPlan("gold")).toBe(false);
  });
});

describe("free plan", () => {
  it("is an accepted plan", () => {
    expect(isPlan("free")).toBe(true);
    expect(PLANS).toContain("free");
  });

  it("has no trial state, so nothing can call it expired", () => {
    // The free tier is open-ended. trialState is what the console and the ops
    // job read to decide a tenant's standing; anything other than "none" here
    // would eventually present a free workspace as an expiring one.
    expect(trialState("free", null)).toBe("none");
    expect(trialState("free", new Date("2000-01-01"))).toBe("none");
  });

  it("is excluded by the ops job's SQL, not merely by a null date", () => {
    // The suspension candidates come from a Postgres function, so no unit test
    // exercises the real predicate. Reading the source is the only way to
    // notice if someone widens it. Two independent reasons keep free out: the
    // plan filter and the null trialEndsAt -- assert the plan filter, because
    // that is the one a later edit could remove without thinking about free.
    const sql = readFileSync(path.join(__dirname, "..", "..", "..", "prisma", "rls", "bootstrap.sql"), "utf-8");
    const fnStart = sql.indexOf("platform_expired_trials");
    const bodyStart = sql.indexOf("$$", fnStart);
    const bodyEnd = sql.indexOf("$$", bodyStart + 2);
    const body = sql.slice(bodyStart, bodyEnd);
    expect(body).toContain("plan = 'trial'");
  });
});
