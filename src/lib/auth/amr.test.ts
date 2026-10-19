import { describe, it, expect } from "vitest";
import { readAmr, hasSecondFactor, passkeyAmr, secondFactorGate, signInLabel } from "./amr";

describe("readAmr", () => {
  it("returns the claim as a clean, deduplicated, lower-cased list", () => {
    expect(readAmr({ amr: ["pwd", "OTP", " otp ", "pwd"] })).toEqual(["pwd", "otp"]);
  });
  it("answers an absent, malformed or non-string claim with no methods", () => {
    expect(readAmr({})).toEqual([]);
    expect(readAmr(null)).toEqual([]);
    expect(readAmr(undefined)).toEqual([]);
    expect(readAmr({ amr: "pwd otp" })).toEqual([]);
    expect(readAmr({ amr: { pwd: true } })).toEqual([]);
    expect(readAmr({ amr: [1, null, "", "  "] })).toEqual([]);
  });
  it("drops oversized values and caps the list", () => {
    expect(readAmr({ amr: ["x".repeat(33), "otp"] })).toEqual(["otp"]);
    const many = Array.from({ length: 40 }, (_, i) => `m${i}`);
    expect(readAmr({ amr: many })).toHaveLength(16);
  });
});

describe("hasSecondFactor", () => {
  it("is true for what Captivo ID and the common providers send", () => {
    expect(hasSecondFactor(["pwd", "otp"])).toBe(true); // Captivo ID after a code
    expect(hasSecondFactor(["pwd", "otp", "trusted"])).toBe(true); // Captivo ID, trusted device
    expect(hasSecondFactor(["pwd", "mfa"])).toBe(true); // Entra
    expect(hasSecondFactor(["mfa"])).toBe(true); // Auth0
    expect(hasSecondFactor(["pwd", "hwk"])).toBe(true); // Okta, security key
    expect(hasSecondFactor(["fido"])).toBe(true);
  });
  it("is false for a password alone, nothing, or a vocabulary it does not know", () => {
    expect(hasSecondFactor(["pwd"])).toBe(false);
    expect(hasSecondFactor([])).toBe(false);
    expect(hasSecondFactor(["sms"])).toBe(false); // deliberately: SMS is not a second factor here
    expect(hasSecondFactor(["passkey"])).toBe(false);
    expect(hasSecondFactor(["something-new"])).toBe(false);
  });
});

describe("passkeyAmr", () => {
  it("counts a user-verified ceremony as two factors and a bare one as possession", () => {
    expect(passkeyAmr(true)).toEqual(["passkey", "mfa"]);
    expect(hasSecondFactor(passkeyAmr(true))).toBe(true);
    expect(passkeyAmr(false)).toEqual(["passkey"]);
    expect(hasSecondFactor(passkeyAmr(false))).toBe(false);
  });
});

describe("secondFactorGate", () => {
  it("lets everything through when the policy is off", () => {
    expect(secondFactorGate({ required: false, amr: [], steppedUp: false })).toBe("allow");
    expect(secondFactorGate({ required: false, amr: ["pwd"], steppedUp: true })).toBe("allow");
  });
  it("lets a proven sign-in through", () => {
    expect(secondFactorGate({ required: true, amr: ["pwd", "otp"], steppedUp: false })).toBe("allow");
    expect(secondFactorGate({ required: true, amr: ["passkey", "mfa"], steppedUp: true })).toBe("allow");
  });
  it("asks the provider to re-authenticate once, then refuses", () => {
    expect(secondFactorGate({ required: true, amr: ["pwd"], steppedUp: false })).toBe("step_up");
    expect(secondFactorGate({ required: true, amr: ["pwd"], steppedUp: true })).toBe("refuse");
    expect(secondFactorGate({ required: true, amr: [], steppedUp: false })).toBe("step_up");
    expect(secondFactorGate({ required: true, amr: [], steppedUp: true })).toBe("refuse");
  });
});

describe("signInLabel", () => {
  it("names the sign-in in one word", () => {
    expect(signInLabel(["pwd", "otp"])).toBe("Two-step");
    expect(signInLabel(["passkey", "mfa"])).toBe("Two-step");
    expect(signInLabel(["passkey"])).toBe("Passkey");
    expect(signInLabel(["pwd"])).toBe("Password");
    expect(signInLabel([])).toBe("—");
    expect(signInLabel(["kba"])).toBe("kba");
  });
});
