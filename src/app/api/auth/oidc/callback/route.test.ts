import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const SRC = readFileSync(path.join(__dirname, "route.ts"), "utf-8");

describe("OIDC callback: entitled identity with no account", () => {
  it("consults the ACCESS grant before giving up with no_account", () => {
    // The order is the whole feature: an entitled identity has neither a user
    // nor an invite in any tenant, so the existing two branches both miss and
    // the old code answered no_account -- a dead end for exactly the person
    // this slice exists to serve.
    const noAccount = SRC.indexOf('"no_account"');
    const grant = SRC.indexOf("accessGrant(");
    expect(grant, "accessGrant is not used in the callback").toBeGreaterThan(-1);
    expect(grant).toBeLessThan(noAccount);
  });

  it("only offers workspace creation on the platform host", () => {
    // On a tenant console the same identity must still get no_account: a
    // grant is not membership of the tenant whose host they happen to be on.
    // The COMPARISON is asserted, not the identifier: merely importing
    // PLATFORM_TENANT_ID would satisfy a looser check while the branch ran
    // everywhere.
    expect(SRC).toMatch(/currentTenantId\(\)\s*===\s*PLATFORM_TENANT_ID/);
  });

  it("carries the organisation to the next step in a signed value", () => {
    // The next step trusts what it is handed. An unsigned cookie would let
    // anyone who reaches /workspace/new name an organisation and be believed.
    // This also pins where the secret comes from: matching the bare function
    // name would still pass if the call site signed with an attacker-
    // controllable value instead of the real one, so the assertion ties the
    // signing call to the CAPTIVO_ID_CLIENT_SECRET read that feeds it.
    expect(SRC).toMatch(
      /const secret = process\.env\.CAPTIVO_ID_CLIENT_SECRET[\s\S]{0,300}?signWorkspaceClaim\([\s\S]{0,300}?,\s*secret\s*,?\s*\)/,
    );
  });

  it("offers workspace creation only when there is no invite to accept", () => {
    // The comment above the branch always claimed "no user and no invite
    // anywhere yet"; the code did not check the second half. A platform
    // operator who was invited to the console AND holds an ACCESS grant was
    // redirected to workspace creation on every sign-in and could never
    // accept their invite.
    expect(SRC).toMatch(/if \([^)]*!invite[^)]*\)[\s\S]{0,600}?accessGrant\(/);
  });
});

/**
 * RFC 6265 §5.1.4 path-match: is a cookie stored with `cookiePath` sent on a
 * request for `requestPath`?
 */
function pathMatches(requestPath: string, cookiePath: string): boolean {
  if (requestPath === cookiePath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith("/") || requestPath[cookiePath.length] === "/";
}

describe("the handoff cookie's path", () => {
  // The handler cannot be driven end to end here (it needs a live IdP, JWKS
  // and the database), so the path literal is read out of the source and then
  // run through the real rule. That is what makes this fail rather than pass
  // on a plausible-looking wrong value: "/workspace" IS reachable from
  // /workspace/new, which is why the bug survived a whole task review.
  const cookiePath = SRC.match(
    /cookies\.set\("captivo_workspace"[\s\S]{0,300}?path:\s*"([^"]+)"/,
  )?.[1];

  it("is written with a path at all", () => {
    expect(cookiePath, "no path found on the captivo_workspace cookie").toBeDefined();
  });

  it("covers the endpoint the form posts to, not just the page", () => {
    // The page renders, the person submits, and the endpoint sees no cookie:
    // the whole feature dead-ends at 401 "Your sign-in expired".
    expect(pathMatches("/api/workspace/create", cookiePath!)).toBe(true);
  });

  it("still covers the page that reads it", () => {
    expect(pathMatches("/workspace/new", cookiePath!)).toBe(true);
  });
});
