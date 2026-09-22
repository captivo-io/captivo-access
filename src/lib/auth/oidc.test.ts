import { describe, it, expect } from "vitest";
import { normalizeIssuer, codeChallengeS256, checkClaims, accessGrant, authorizationScope, type IdClaims } from "./oidc";

describe("normalizeIssuer", () => {
  it("strips a single trailing slash", () => {
    expect(normalizeIssuer("https://accounts.google.com/")).toBe("https://accounts.google.com");
  });
  it("leaves a slash-less issuer alone", () => {
    expect(normalizeIssuer("https://login.microsoftonline.com/t/v2.0")).toBe("https://login.microsoftonline.com/t/v2.0");
  });
});

describe("codeChallengeS256 (RFC 7636 Appendix B vector)", () => {
  it("derives the known challenge from the known verifier", () => {
    expect(codeChallengeS256("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"))
      .toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });
});

describe("checkClaims", () => {
  const base = { issuer: "https://idp.example.com", clientId: "client-123", nonce: "n-abc" };
  const good = {
    iss: "https://idp.example.com", aud: "client-123", nonce: "n-abc",
    email: "Dana@Acme.com", email_verified: true, name: "Dana",
  };
  it("accepts a well-formed token and lowercases the email", () => {
    expect(checkClaims(good, base)).toEqual({ ok: true, email: "dana@acme.com" });
  });
  it("rejects a wrong issuer", () => {
    expect(checkClaims({ ...good, iss: "https://evil.example.com" }, base).ok).toBe(false);
  });
  it("rejects when aud does not include the client id", () => {
    expect(checkClaims({ ...good, aud: "other-client" }, base).ok).toBe(false);
  });
  it("rejects an aud array that omits the client id", () => {
    expect(checkClaims({ ...good, aud: ["other-a", "other-b"] }, base).ok).toBe(false);
  });
  it("rejects when azp mismatches on a multi-aud token", () => {
    expect(checkClaims({ ...good, aud: ["client-123", "x"], azp: "x" }, base).ok).toBe(false);
  });
  it("accepts a multi-aud token whose azp matches", () => {
    expect(checkClaims({ ...good, aud: ["client-123", "x"], azp: "client-123" }, base).ok).toBe(true);
  });
  it("rejects a mismatched nonce", () => {
    expect(checkClaims({ ...good, nonce: "n-other" }, base).ok).toBe(false);
  });
  it("rejects an unverified email", () => {
    expect(checkClaims({ ...good, email_verified: false }, base).ok).toBe(false);
  });
  it("rejects a non-boolean truthy email_verified (string \"true\")", () => {
    expect(checkClaims({ ...good, email_verified: "true" as unknown as boolean }, base).ok).toBe(false);
  });
  it("rejects a missing email", () => {
    expect(checkClaims({ ...good, email: undefined }, base).ok).toBe(false);
  });
  // The caller passes the discovery document's authoritative `issuer`, which for
  // some IdPs (e.g. Auth0) carries a trailing slash. A trailing-slash iss must
  // match a trailing-slash expected issuer exactly — and must NOT match the
  // slash-stripped form (the bug this guards: never compare against a normalized issuer).
  it("matches an issuer verbatim, trailing slash included (Auth0)", () => {
    const slash = { issuer: "https://x.us.auth0.com/", clientId: "client-123", nonce: "n-abc" };
    expect(checkClaims({ ...good, iss: "https://x.us.auth0.com/" }, slash).ok).toBe(true);
    expect(checkClaims({ ...good, iss: "https://x.us.auth0.com" }, slash).ok).toBe(false);
  });
});

describe("accessGrant", () => {
  const base = (captivo: unknown): IdClaims =>
    ({ iss: "https://id.captivo.io", aud: "captivo-access", email: "a@b.co", captivo } as IdClaims);

  it("returns the ACCESS grant with its organisation", () => {
    const g = accessGrant(base({ grants: [{ org: "o1", orgName: "Acme", product: "ACCESS", role: "OWNER" }] }));
    expect(g).toEqual({ org: "o1", orgName: "Acme", role: "OWNER" });
  });

  it("ignores a grant for another product", () => {
    // A Portal-only customer must not be handed an Access workspace.
    expect(accessGrant(base({ grants: [{ org: "o1", orgName: "Acme", product: "PORTAL", role: "OWNER" }] }))).toBeNull();
  });

  it("picks the ACCESS grant out of several", () => {
    const g = accessGrant(base({
      grants: [
        { org: "o1", orgName: "Acme", product: "PORTAL", role: "OWNER" },
        { org: "o1", orgName: "Acme", product: "ACCESS", role: "ADMIN" },
      ],
    }));
    expect(g?.role).toBe("ADMIN");
  });

  it("refuses a grant with no usable organisation name", () => {
    // The name becomes the workspace's name and seeds its slug; an empty one
    // would produce a workspace nobody can identify.
    expect(accessGrant(base({ grants: [{ org: "o1", orgName: "", product: "ACCESS", role: "OWNER" }] }))).toBeNull();
    expect(accessGrant(base({ grants: [{ org: "o1", product: "ACCESS", role: "OWNER" }] }))).toBeNull();
  });

  it("refuses a grant with no organisation id", () => {
    expect(accessGrant(base({ grants: [{ orgName: "Acme", product: "ACCESS", role: "OWNER" }] }))).toBeNull();
  });

  it("survives a missing or malformed claim without throwing", () => {
    // The claim is attacker-influenced only in the sense that a broken issuer
    // could send anything; this must fail closed rather than crash the callback.
    expect(accessGrant(base(undefined))).toBeNull();
    expect(accessGrant(base({}))).toBeNull();
    expect(accessGrant(base({ grants: "not-an-array" }))).toBeNull();
    expect(accessGrant(base({ grants: [null, 7, "x"] }))).toBeNull();
  });

  it("never throws on a null or undefined claims object", () => {
    // The callback is the only way in; an exception there locks out everyone.
    // This is unreachable today (claims comes from jwtVerify().payload) but
    // defensive to guard anyway.
    expect(accessGrant(null as unknown as IdClaims)).toBeNull();
    expect(accessGrant(undefined as unknown as IdClaims)).toBeNull();
  });

  it("skips an unusable grant and returns a valid one from the same person", () => {
    // A person with access to two organisations should get the first usable
    // one, even if one organisation's grant is malformed.
    const g = accessGrant(base({
      grants: [
        { org: "o1", orgName: "", product: "ACCESS", role: "OWNER" },
        { org: "o2", orgName: "Acme Corp", product: "ACCESS", role: "ADMIN" },
      ],
    }));
    expect(g).toEqual({ org: "o2", orgName: "Acme Corp", role: "ADMIN" });
  });
});

describe("authorizationScope", () => {
  it("asks for the captivo scope when the issuer advertises it", () => {
    const scope = authorizationScope(["openid", "email", "profile", "offline_access", "captivo"]);
    expect(scope.split(" ")).toContain("captivo");
  });

  it("omits the captivo scope when the issuer does not advertise it", () => {
    // A tenant pointing its console at Keycloak/Entra/Auth0: asking for an
    // unknown scope is answered with invalid_scope and kills the whole login.
    const scope = authorizationScope(["openid", "email", "profile"]);
    expect(scope.split(" ")).not.toContain("captivo");
    expect(scope).toBe("openid email profile");
  });

  it("omits it when the issuer states no scopes at all", () => {
    // scopes_supported is only RECOMMENDED by the discovery spec.
    expect(authorizationScope(undefined).split(" ")).not.toContain("captivo");
    expect(authorizationScope("captivo").split(" ")).not.toContain("captivo");
    expect(authorizationScope({ captivo: true }).split(" ")).not.toContain("captivo");
  });

  it("always asks for the three scopes every login needs", () => {
    for (const advertised of [["openid", "email", "profile", "captivo"], ["openid"], undefined]) {
      const scope = authorizationScope(advertised).split(" ");
      expect(scope).toEqual(expect.arrayContaining(["openid", "email", "profile"]));
    }
  });
});
