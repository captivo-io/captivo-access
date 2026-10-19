import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * An organisation member must join the tenant that belongs to their
 * organisation -- and only that one, and only from the platform's own
 * identity provider.
 */
const ROUTE = readFileSync(join(__dirname, "route.ts"), "utf8");

describe("oidc callback: organisation member joins the workspace", () => {
  it("looks up the tenant's organisation and matches the grant to it", () => {
    expect(ROUTE).toMatch(/select: \{ captivoOrgId: true \}/);
    expect(ROUTE).toMatch(/accessGrantFor\(claims, tenant\.captivoOrgId\)/);
  });

  it("only on a tenant console, only from the platform provider, only without an invite", () => {
    expect(ROUTE).toMatch(/if \(!invite && cfg\.isPlatform && currentTenantId\(\) !== PLATFORM_TENANT_ID\)/);
  });

  it("the console role comes from the organisation role, never from the token verbatim", () => {
    expect(ROUTE).toMatch(/role: accessRoleForGrant\(grant\.role\)/);
  });

  it("the join happens after the second-factor gate, so a refused sign-in creates nobody", () => {
    expect(ROUTE.indexOf("secondFactorGate(")).toBeLessThan(ROUTE.indexOf("accessGrantFor(claims"));
  });
});
