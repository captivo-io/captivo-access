import { describe, it, expect } from "vitest";
import { runSsoTest } from "./steps";

const cfg = { issuer: "https://acme.okta.com", clientId: "abc", hasSecret: true };
const ok = { discover: async () => ({ jwks_uri: "https://acme.okta.com/keys" }), fetchJwks: async () => ({ keys: [{}, {}] }) };

describe("SSO connection test", () => {
  it("passes all three steps", async () => {
    const r = await runSsoTest(cfg, ok);
    expect(r.ok).toBe(true);
    expect(r.steps.map((s) => [s.key, s.ok, s.detail])).toEqual([["discovery", true, "found"], ["jwks", true, "2 keys"], ["client", true, "both saved"]]);
  });
  it("fails at discovery without an issuer or when the IdP is unreachable", async () => {
    expect((await runSsoTest(null, ok)).error).toBe("no_issuer");
    const r = await runSsoTest(cfg, { ...ok, discover: async () => { throw new Error("discovery_failed_404"); } });
    expect(r.error).toBe("unreachable");
    expect(r.steps).toEqual([{ key: "discovery", ok: false, detail: "HTTP 404" }]);
  });
  it("fails at the keys when the JWKS has none", async () => {
    const r = await runSsoTest(cfg, { ...ok, fetchJwks: async () => ({ keys: [] }) });
    expect(r.error).toBe("jwks_failed");
    expect(r.steps).toHaveLength(2);
  });
  it("fails at the credentials step when the secret is not saved, without claiming to verify it", async () => {
    const r = await runSsoTest({ ...cfg, hasSecret: false }, ok);
    expect(r.error).toBe("credentials_missing");
    expect(r.steps[2]).toEqual({ key: "client", ok: false, detail: "client secret missing" });
  });
});

describe("the Cloud guard's refusal", () => {
  it("is named, not reported as an unreachable issuer", async () => {
    const refused = Object.assign(new Error("refused: 10.0.0.5 is on a private or internal network"), { name: "PrivateAddressError" });
    const r = await runSsoTest({ issuer: "https://idp.internal", clientId: "c", hasSecret: true }, { discover: async () => { throw refused; }, fetchJwks: async () => ({}) });
    expect(r.error).toBe("private_address");
  });
});
