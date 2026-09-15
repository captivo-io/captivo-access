import { describe, it, expect } from "vitest";
import { readPlatformOidc, pickOidcSource } from "./oidc-source";

const PLATFORM = { issuer: "https://id.captivo.io", clientId: "captivo-access", clientSecret: "s3cret" };
const TENANT = { enabled: true, issuer: "https://acme.okta.com", clientId: "abc", hasSecret: true };

describe("platform provider from the environment", () => {
  it("reads it when all three values are present", () => {
    expect(readPlatformOidc({
      CAPTIVO_ID_ISSUER: PLATFORM.issuer,
      CAPTIVO_ID_CLIENT_ID: PLATFORM.clientId,
      CAPTIVO_ID_CLIENT_SECRET: PLATFORM.clientSecret,
    })).toEqual(PLATFORM);
  });

  it("treats a HALF configuration as none", () => {
    // A half-configured provider produces a sign-in button that fails at the
    // token exchange -- after the person has typed their password.
    expect(readPlatformOidc({ CAPTIVO_ID_ISSUER: PLATFORM.issuer })).toBeNull();
    expect(readPlatformOidc({ CAPTIVO_ID_ISSUER: PLATFORM.issuer, CAPTIVO_ID_CLIENT_ID: "x" })).toBeNull();
    expect(readPlatformOidc({})).toBeNull();
  });

  it("ignores whitespace-only values", () => {
    expect(readPlatformOidc({
      CAPTIVO_ID_ISSUER: "  ", CAPTIVO_ID_CLIENT_ID: "x", CAPTIVO_ID_CLIENT_SECRET: "y",
    })).toBeNull();
  });
});

describe("which provider applies", () => {
  it("the tenant's OWN provider beats the platform one", () => {
    // A customer who federated with their own identity provider must not be
    // silently moved onto ours: their directory is where joiners and leavers
    // are managed, and bypassing it is a security regression dressed as a
    // feature.
    expect(pickOidcSource(TENANT, PLATFORM)).toEqual({ kind: "tenant" });
  });

  it("falls back to the platform provider when the tenant has none", () => {
    expect(pickOidcSource(null, PLATFORM)).toEqual({ kind: "platform", config: PLATFORM });
  });

  it("a tenant who DISABLED their SSO does not fall back", () => {
    // Disabling is a deliberate act meaning "no SSO", not "use the other one".
    // Falling back here would turn a tenant's decision into its opposite.
    expect(pickOidcSource({ ...TENANT, enabled: false }, PLATFORM)).toEqual({ kind: "none" });
  });

  it("no tenant and no platform means no SSO -- passkey and password remain", () => {
    expect(pickOidcSource(null, null)).toEqual({ kind: "none" });
  });

  it("no tenant and a half-configured platform means no SSO", () => {
    expect(pickOidcSource(null, readPlatformOidc({ CAPTIVO_ID_ISSUER: "x" }))).toEqual({ kind: "none" });
  });
});
