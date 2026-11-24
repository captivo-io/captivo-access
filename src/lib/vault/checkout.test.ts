import { describe, expect, it } from "vitest";
import { checkoutBlock, checkoutEnd, validCheckoutMinutes } from "./checkout";

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
