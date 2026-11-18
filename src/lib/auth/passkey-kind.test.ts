import { describe, it, expect } from "vitest";
import { passkeyLabel, passkeySynced, PASSKEY_LABEL_MAX } from "./passkey-kind";

describe("passkeySynced", () => {
  it("multi-device (backup eligible) credentials are synced", () => {
    expect(passkeySynced({ credentialDeviceType: "multiDevice", credentialBackedUp: false })).toBe(true);
    expect(passkeySynced({ credentialDeviceType: "multiDevice", credentialBackedUp: true })).toBe(true);
  });
  it("single-device credentials are security keys, unless already backed up", () => {
    expect(passkeySynced({ credentialDeviceType: "singleDevice", credentialBackedUp: false })).toBe(false);
    expect(passkeySynced({ credentialDeviceType: "singleDevice", credentialBackedUp: true })).toBe(true);
  });
  it("unknown when the library reports nothing", () => {
    expect(passkeySynced({})).toBeNull();
  });
});

describe("passkeyLabel", () => {
  it("trims and collapses spaces", () => {
    expect(passkeyLabel("  Work   laptop ")).toBe("Work laptop");
  });
  it("refuses empty, too long and non-string names", () => {
    expect(passkeyLabel("   ")).toBeNull();
    expect(passkeyLabel("x".repeat(PASSKEY_LABEL_MAX + 1))).toBeNull();
    expect(passkeyLabel(42)).toBeNull();
    expect(passkeyLabel(undefined)).toBeNull();
  });
  it("accepts exactly the maximum", () => {
    expect(passkeyLabel("x".repeat(PASSKEY_LABEL_MAX))).toHaveLength(PASSKEY_LABEL_MAX);
  });
});
