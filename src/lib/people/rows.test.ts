import { describe, it, expect } from "vitest";
import { inviteState, userSource, latest, isMobileAgent, inviteTtlChoices, ttlLabel } from "./rows";

describe("people rows", () => {
  const now = new Date("2026-11-18T12:00:00Z");
  it("names an invite's state", () => {
    expect(inviteState({ usedAt: now, expiresAt: new Date(0) }, now)).toBe("used");
    expect(inviteState({ usedAt: null, expiresAt: new Date("2026-11-17T00:00:00Z") }, now)).toBe("expired");
    expect(inviteState({ usedAt: null, expiresAt: new Date("2026-11-19T00:00:00Z") }, now)).toBe("pending");
  });
  it("tells where an account comes from", () => {
    expect(userSource({ centerRole: "ADMIN", directoryManaged: true })).toBe("captivo");
    expect(userSource({ centerRole: null, directoryManaged: true })).toBe("directory");
    expect(userSource({ centerRole: null, directoryManaged: false })).toBe("local");
  });
  it("picks the latest activity", () => {
    expect(latest(null, undefined)).toBeNull();
    expect(latest(new Date("2026-01-01T00:00:00Z"), now)).toBe(now.toISOString());
  });
  it("spots phones", () => {
    expect(isMobileAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)")).toBe(true);
    expect(isMobileAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/157")).toBe(false);
  });
  it("offers the policy's invite lifetime too", () => {
    expect(inviteTtlChoices(72)).toEqual([24, 72, 168]);
    expect(inviteTtlChoices(48)).toEqual([24, 48, 72, 168]);
    expect(ttlLabel(24)).toBe("24 hours");
    expect(ttlLabel(72)).toBe("3 days");
    expect(ttlLabel(48)).toBe("2 days");
    expect(ttlLabel(12)).toBe("12 hours");
  });
});
