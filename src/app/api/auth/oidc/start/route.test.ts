import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { authorizationScope } from "@/lib/auth/oidc";

const SRC = readFileSync(path.join(__dirname, "route.ts"), "utf-8");

describe("OIDC start: the requested scope", () => {
  it("derives the scope from the issuer instead of hard-coding it", () => {
    // THIS IS THE BUG THIS FILE EXISTS FOR. The route asked for a fixed
    // "openid email profile", so Captivo ID -- which releases the grant claim
    // only under the `captivo` scope -- returned a valid token with no grants
    // in it, and the callback answered no_account to people who were entitled.
    // A passing unit test on authorizationScope proves nothing while the call
    // site still writes its own literal, which is exactly what happened.
    expect(SRC).toMatch(/set\("scope",\s*authorizationScope\(/);
  });

  it("feeds it what the issuer advertises, not a value of its own", () => {
    // Pinning the argument as well: authorizationScope([]) would satisfy the
    // assertion above while asking for the base scopes forever.
    expect(SRC).toMatch(/set\("scope",\s*authorizationScope\(\s*disc\.scopes_supported\s*\)\s*\)/);
  });

  it("keeps the whole discovery document, since scopes_supported lives on it", () => {
    expect(SRC).not.toMatch(/authorization_endpoint\s*;/);
    expect(SRC).toMatch(/disc\s*=\s*await discover\(/);
  });

  it("asks Captivo ID for the grant claim", () => {
    // The live issuer advertises these; this is the value the route now sends.
    const scope = authorizationScope(["openid", "email", "profile", "offline_access", "captivo"]);
    expect(scope).toBe("openid email profile captivo");
  });
});
