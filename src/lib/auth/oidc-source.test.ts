import { describe, it, expect } from "vitest";
import { readPlatformOidc, pickOidcSource } from "./oidc-source";

const PLATFORM = { issuer: "https://id.captivo.io", clientId: "captivo-access", clientSecret: "s3cret" };
// Captivo ID is a hosted-service feature, so every case below that expects it
// to be read must say it is running the hosted service.
const SAAS = { CAPTIVO_DEPLOYMENT: "saas" };
const TENANT = { enabled: true, issuer: "https://acme.okta.com", clientId: "abc", hasSecret: true };

describe("platform provider from the environment", () => {
  it("reads it when all three values are present", () => {
    expect(readPlatformOidc({
      ...SAAS,
      CAPTIVO_ID_ISSUER: PLATFORM.issuer,
      CAPTIVO_ID_CLIENT_ID: PLATFORM.clientId,
      CAPTIVO_ID_CLIENT_SECRET: PLATFORM.clientSecret,
    })).toEqual(PLATFORM);
  });

  it("treats a HALF configuration as none", () => {
    // A half-configured provider produces a sign-in button that fails at the
    // token exchange -- after the person has typed their password.
    expect(readPlatformOidc({ ...SAAS, CAPTIVO_ID_ISSUER: PLATFORM.issuer })).toBeNull();
    expect(readPlatformOidc({ ...SAAS, CAPTIVO_ID_ISSUER: PLATFORM.issuer, CAPTIVO_ID_CLIENT_ID: "x" })).toBeNull();
    expect(readPlatformOidc({ ...SAAS })).toBeNull();
  });

  it("ignores whitespace-only values", () => {
    expect(readPlatformOidc({
      ...SAAS, CAPTIVO_ID_ISSUER: "  ", CAPTIVO_ID_CLIENT_ID: "x", CAPTIVO_ID_CLIENT_SECRET: "y",
    })).toBeNull();
  });

  it("is NEVER read on a customer's own server", () => {
    // Captivo ID lives on the internet. A self-hosted console that depended on
    // it would be locked out whenever that link was down, and permanently in an
    // air-gapped network. Setting the variables must not be enough.
    const configured = {
      CAPTIVO_ID_ISSUER: PLATFORM.issuer,
      CAPTIVO_ID_CLIENT_ID: PLATFORM.clientId,
      CAPTIVO_ID_CLIENT_SECRET: PLATFORM.clientSecret,
    };
    expect(readPlatformOidc({ ...configured, CAPTIVO_DEPLOYMENT: "self-hosted" })).toBeNull();
    // Unset means self-hosted: an installation that does not declare itself is
    // treated as someone else's server, so the failure is a missing button
    // rather than a dependency nobody asked for.
    expect(readPlatformOidc(configured)).toBeNull();
    // A typo is not "saas" either.
    expect(readPlatformOidc({ ...configured, CAPTIVO_DEPLOYMENT: "SaaS" })).toBeNull();
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

