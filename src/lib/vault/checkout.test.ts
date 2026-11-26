import { describe, expect, it } from "vitest";
import { checkoutBlock, checkoutEnd, checkoutMinutesFor, pickCheckoutGrant, validCheckoutMinutes, type CheckoutGrantRow } from "./checkout";

const site = { passwordCheckout: true, accessMode: "GATEWAY", requireModerator: false };
const cred = { secretKind: "PASSWORD", secretSource: null, sealedTo: "k" };

describe("password check-out rules", () => {
  it("is allowed for a remote desktop, SSH or database password kept sealed here", () => {
    expect(checkoutBlock(site, cred)).toBeNull();
    expect(checkoutBlock({ ...site, accessMode: "DATABASE" }, cred)).toBeNull();
  });
  it("says why not", () => {
    expect(checkoutBlock({ ...site, passwordCheckout: false }, cred)).toBe("off");
    expect(checkoutBlock({ ...site, accessMode: "KUBERNETES" }, cred)).toBe("kind");
    expect(checkoutBlock({ ...site, accessMode: "TRANSPARENT" }, cred)).toBe("kind");
    expect(checkoutBlock(site, { ...cred, secretKind: "KEY" })).toBe("kind");
    expect(checkoutBlock(site, null)).toBe("kind");
    expect(checkoutBlock(site, { ...cred, secretSource: "aws" })).toBe("vault");
    expect(checkoutBlock(site, { ...cred, sealedTo: null })).toBe("unsealed");
    expect(checkoutBlock({ ...site, requireModerator: true }, cred)).toBe("moderated");
  });
  it("ends at the resource's limit or the grant's end, whichever is first", () => {
    const now = new Date("2026-11-25T10:00:00Z");
    expect(checkoutEnd(now, 240, null).toISOString()).toBe("2026-11-25T14:00:00.000Z");
    expect(checkoutEnd(now, 240, new Date("2026-11-25T11:00:00Z")).toISOString()).toBe("2026-11-25T11:00:00.000Z");
    expect(checkoutEnd(now, 60, new Date("2026-11-25T18:00:00Z")).toISOString()).toBe("2026-11-25T11:00:00.000Z");
  });
  it("takes a length between 15 minutes and 24 hours", () => {
    expect(validCheckoutMinutes(240)).toBe(240);
    expect(validCheckoutMinutes("60")).toBe(60);
    for (const bad of [5, 1441, 1.5, "x", null, undefined]) expect(validCheckoutMinutes(bad)).toBeNull();
  });
});

describe("which grant lets a person check the password out", () => {
  const now = new Date("2026-11-25T10:00:00Z");
  const grant = (over: Partial<CheckoutGrantRow> = {}): CheckoutGrantRow => ({
    status: "ACTIVE", startsAt: null, endsAt: new Date("2026-11-26T10:00:00Z"), requiresApproval: false, approvedAt: null, schedule: null,
    checkoutDenied: false, checkoutMinutes: null, ...over,
  });

  it("needs a live grant that was not made without the password", () => {
    expect(pickCheckoutGrant([], now)).toBeNull();
    expect(pickCheckoutGrant([grant({ checkoutDenied: true })], now)).toBeNull();
    expect(pickCheckoutGrant([grant({ status: "REVOKED" })], now)).toBeNull();
    expect(pickCheckoutGrant([grant({ endsAt: new Date("2026-11-25T09:00:00Z") })], now)).toBeNull();
    expect(pickCheckoutGrant([grant({ startsAt: new Date("2026-11-25T12:00:00Z") })], now)).toBeNull();
    expect(pickCheckoutGrant([grant()], now)).toEqual({ end: new Date("2026-11-26T10:00:00Z"), minutes: null });
  });

  it("ignores a denying grant next to one that allows it", () => {
    const allowed = grant({ endsAt: new Date("2026-11-25T18:00:00Z"), checkoutMinutes: 60 });
    expect(pickCheckoutGrant([grant({ checkoutDenied: true, endsAt: null }), allowed], now)).toEqual({ end: new Date("2026-11-25T18:00:00Z"), minutes: 60 });
  });

  it("lets the grant that lasts longest decide, an open-ended one beating a dated one", () => {
    const short = grant({ endsAt: new Date("2026-11-25T12:00:00Z"), checkoutMinutes: 30 });
    const long = grant({ endsAt: new Date("2026-11-27T12:00:00Z"), checkoutMinutes: 240 });
    const open = grant({ endsAt: null, checkoutMinutes: 15 });
    expect(pickCheckoutGrant([short, long], now)?.minutes).toBe(240);
    expect(pickCheckoutGrant([long, short], now)?.minutes).toBe(240);
    expect(pickCheckoutGrant([long, open], now)).toEqual({ end: null, minutes: 15 });
    expect(pickCheckoutGrant([open, long], now)).toEqual({ end: null, minutes: 15 });
  });

  it("uses the grant's length but never more than the resource's limit", () => {
    expect(checkoutMinutesFor(240, null)).toBe(240);
    expect(checkoutMinutesFor(240, 60)).toBe(60);
    expect(checkoutMinutesFor(60, 480)).toBe(60);
  });
});
