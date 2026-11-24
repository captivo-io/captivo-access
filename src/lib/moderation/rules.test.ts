import { describe, expect, it } from "vitest";
import { ADMISSION_MS, MODERATION_WAIT_MS, canModerate, moderationBlock, moderationRequired, statusOf } from "./rules";

const t0 = new Date("2026-11-24T10:00:00Z");
const at = (ms: number) => new Date(t0.getTime() + ms);

describe("moderated sessions", () => {
  it("applies to remote-desktop resources that ask for it", () => {
    expect(moderationRequired({ accessMode: "GATEWAY", requireModerator: true })).toBe(true);
    expect(moderationRequired({ accessMode: "GATEWAY", requireModerator: false })).toBe(false);
    expect(moderationRequired({ accessMode: "TUNNEL", requireModerator: true })).toBe(false);
  });
  it("lets admins moderate, and operators unless Policy says admins only", () => {
    expect(canModerate("ADMIN", "admins")).toBe(true);
    expect(canModerate("OPERATOR", "admins")).toBe(false);
    expect(canModerate("OPERATOR", "admins_operators")).toBe(true);
    expect(canModerate("AUDITOR", "admins_operators")).toBe(false);
    expect(canModerate("VENDOR", "admins_operators")).toBe(false);
  });
  it("lets a waiting request and an admission run out", () => {
    const waiting = { status: "waiting", requestedAt: t0, decidedAt: null };
    expect(statusOf(waiting, at(MODERATION_WAIT_MS - 1))).toBe("waiting");
    expect(statusOf(waiting, at(MODERATION_WAIT_MS + 1))).toBe("expired");
    const admitted = { status: "admitted", requestedAt: t0, decidedAt: at(60_000) };
    expect(statusOf(admitted, at(60_000 + ADMISSION_MS - 1))).toBe("admitted");
    expect(statusOf(admitted, at(60_000 + ADMISSION_MS + 1))).toBe("expired");
    expect(statusOf({ status: "started", requestedAt: t0, decidedAt: t0 }, at(86_400_000))).toBe("started");
  });
  it("keeps native clients a moderator couldn't watch out", () => {
    expect(moderationBlock("native_rdp", true)).toBe("moderator_browser_only");
    expect(moderationBlock("native_ssh", false)).toBe("moderator_needs_recording");
    expect(moderationBlock("native_ssh", true)).toBeNull();
  });
});
