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
});
