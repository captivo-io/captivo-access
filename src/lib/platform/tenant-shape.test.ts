import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseLimits, parseCapabilities, limitsForStorage, withinLimit, formatBytes, isPlan, PLANS } from "./tenant-shape";

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

describe("withinLimit / formatBytes / isPlan", () => {
  it("withinLimit", () => {
    expect(withinLimit({}, "maxUsers", 999)).toBe(true);
    expect(withinLimit({ maxUsers: 3 }, "maxUsers", 2)).toBe(true);
    expect(withinLimit({ maxUsers: 3 }, "maxUsers", 3)).toBe(false);
  });
  it("trial diye bir plan yok", () => {
    // Product decision (2026-09-23): the free tier IS the trial. Nothing
    // creates a time-limited plan any more, so a workspace never disappears
    // because a clock ran out; someone who needs more capacity buys it.
    expect(PLANS).not.toContain("trial");
    expect(isPlan("trial")).toBe(false);
    expect([...PLANS].sort()).toEqual(["enterprise", "free", "standard"]);
  });

  it("formatBytes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(5 * 1024 * 1024 * 1024)).toBe("5.0 GB");
  });
  it("isPlan", () => {
    expect(isPlan("standard")).toBe(true);
    expect(isPlan("gold")).toBe(false);
  });
});

describe("free plan", () => {
  it("is an accepted plan", () => {
    expect(isPlan("free")).toBe(true);
    expect(PLANS).toContain("free");
  });

  it("cannot be turned into an expiring plan by the database either", () => {
    // The allow-list is a SECURITY DEFINER function, so no unit test exercises
    // it; reading the source is the only way to notice a plan creeping back.
    // The TypeScript union and this list are compared for equality by
    // plan-sql-parity.test.ts -- this assertion is the narrower one that says
    // WHICH name must stay out, so a regression reads as itself.
    const sql = readFileSync(path.join(__dirname, "..", "..", "..", "prisma", "rls", "bootstrap.sql"), "utf-8");
    const guard = sql.match(/p_plan NOT IN \(([^)]*)\)/);
    expect(guard, "platform_update_tenant no longer guards p_plan").not.toBeNull();
    expect(guard![1]).not.toContain("trial");
  });

  it("leaves no job that can suspend a workspace for running out of time", () => {
    // platform_expired_trials() was the only thing that suspended a tenant on
    // a clock. It is gone, and bootstrap.sql drops it where it already exists
    // -- an upgraded database must not keep a SECURITY DEFINER function that
    // nothing calls.
    const sql = readFileSync(path.join(__dirname, "..", "..", "..", "prisma", "rls", "bootstrap.sql"), "utf-8");
    expect(sql).toContain("DROP FUNCTION IF EXISTS platform_expired_trials();");
    expect(sql).not.toContain("CREATE OR REPLACE FUNCTION platform_expired_trials()");
  });
});
