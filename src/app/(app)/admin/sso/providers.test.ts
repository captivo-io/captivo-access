import { describe, it, expect } from "vitest";
import { providerFromIssuer, staffSignIn, ssoChip } from "./providers";

describe("SSO providers", () => {
  it("reads the provider from the saved issuer", () => {
    expect(providerFromIssuer("https://login.microsoftonline.com/abc/v2.0")).toBe("entra");
    expect(providerFromIssuer("https://accounts.google.com")).toBe("google");
    expect(providerFromIssuer("https://acme.okta.com/oauth2/default")).toBe("okta");
    expect(providerFromIssuer("https://acme.oktapreview.com")).toBe("okta");
    expect(providerFromIssuer("https://auth.acme.io")).toBe("oidc");
    expect(providerFromIssuer("not a url")).toBe("oidc");
  });

  it("says how admins and operators sign in, as pickOidcSource decides", () => {
    expect(staffSignIn({ enabled: true, issuer: "https://login.microsoftonline.com/x/v2.0" }, true).how).toBe("Microsoft Entra (SSO)");
    // A switched-off tenant provider does not fall back to Captivo ID.
    expect(staffSignIn({ enabled: false, issuer: "https://acme.okta.com" }, true).how).toBe("Passkey");
    expect(staffSignIn(null, true).how).toBe("Captivo ID");
    expect(staffSignIn(null, false).how).toBe("Passkey");
  });

  it("chips the state", () => {
    expect(ssoChip(true, false)).toBe("on");
    expect(ssoChip(false, true)).toBe("ready");
    expect(ssoChip(false, false)).toBe("off");
  });
});
