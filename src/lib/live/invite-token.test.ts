import { describe, expect, it } from "vitest";
import {
  guestPass, hashSecret, inviteExpiry, inviteStatus, invitableSession, isInviteDuration, linkToken, newSecret,
  parseGuestPass, parseLinkToken, secretMatches,
} from "./invite-token";

describe("session invite tokens", () => {
  it("round-trips the link and the pass, and refuses anything else", () => {
    const s = newSecret();
    expect(s).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(parseLinkToken(linkToken("cmwx1a2b3c4d5e6f7g8h", s))).toEqual({ id: "cmwx1a2b3c4d5e6f7g8h", secret: s });
    expect(parseGuestPass(guestPass("default", "cmwx1a2b3c4d5e6f7g8h", s))).toEqual({ tenantId: "default", id: "cmwx1a2b3c4d5e6f7g8h", secret: s });
    for (const bad of ["", "x", `cmwx1a2b3c4d5e6f7g8h.${s}.x`, `CMWX.${s}`, `cmwx1a2b3c4d5e6f7g8h.short`, `../etc.${s}`]) {
      expect(parseLinkToken(bad)).toBeNull();
    }
    expect(parseGuestPass(`cmwx1a2b3c4d5e6f7g8h.${s}`)).toBeNull();
    expect(parseGuestPass(`a b.cmwx1a2b3c4d5e6f7g8h.${s}`)).toBeNull();
  });

  it("stores only a hash and compares it in constant time", () => {
    const s = newSecret();
    const h = hashSecret(s);
    expect(h).not.toContain(s);
    expect(secretMatches(s, h)).toBe(true);
    expect(secretMatches(newSecret(), h)).toBe(false);
    expect(secretMatches(s, null)).toBe(false);
    expect(secretMatches(s, "abcd")).toBe(false);
  });

  it("expires each choice and caps 'until the session ends'", () => {
    const now = new Date("2026-11-23T10:00:00Z");
    expect(inviteExpiry("15m", now)).toEqual({ expiresAt: new Date("2026-11-23T10:15:00Z"), untilSessionEnds: false });
    expect(inviteExpiry("1h", now).expiresAt).toEqual(new Date("2026-11-23T11:00:00Z"));
    expect(inviteExpiry("session", now)).toEqual({ expiresAt: new Date("2026-11-23T22:00:00Z"), untilSessionEnds: true });
    expect(isInviteDuration("1h")).toBe(true);
    expect(isInviteDuration("2h")).toBe(false);
  });

  it("names an invite's state", () => {
    const now = new Date("2026-11-23T10:00:00Z");
    const later = new Date("2026-11-23T11:00:00Z");
    expect(inviteStatus({ joinedAt: null, revokedAt: null, expiresAt: later }, now)).toBe("waiting");
    expect(inviteStatus({ joinedAt: now, revokedAt: null, expiresAt: later }, now)).toBe("joined");
    expect(inviteStatus({ joinedAt: now, revokedAt: null, expiresAt: now }, now)).toBe("expired");
    expect(inviteStatus({ joinedAt: now, revokedAt: now, expiresAt: later }, now)).toBe("removed");
  });

  it("invites only into sessions whose view the data plane gates", () => {
    expect(invitableSession({ kind: "gateway" })).toBe(true);
    expect(invitableSession({ kind: "gateway", native: true, watchable: true })).toBe(true);
    expect(invitableSession({ kind: "gateway", native: true })).toBe(false);
    expect(invitableSession({ kind: "isolated" })).toBe(false);
    expect(invitableSession({ kind: "database" })).toBe(false);
  });
});
