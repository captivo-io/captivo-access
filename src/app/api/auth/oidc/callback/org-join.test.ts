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
    expect(ROUTE).toMatch(/const grant = tenantOrg \? accessGrantFor\(claims, tenantOrg\) : null/);
  });

  it("only on a tenant console, only from the platform provider, only without an invite", () => {
    expect(ROUTE).toMatch(/if \(!invite && onTenantConsole\)/);
    expect(ROUTE).toMatch(/const onTenantConsole = cfg\.isPlatform && currentTenantId\(\) !== PLATFORM_TENANT_ID/);
  });

  it("the console role comes from the organisation role, never from the token verbatim", () => {
    expect(ROUTE).toMatch(/role: accessRoleForGrant\(grant\.role\)/);
  });

  it("the join happens after the second-factor gate, so a refused sign-in creates nobody", () => {
    expect(ROUTE.indexOf("secondFactorGate(")).toBeLessThan(ROUTE.indexOf("accessGrantFor(claims"));
  });

  it("the newcomer is recorded as centre-managed, with the organisation role", () => {
    expect(ROUTE).toMatch(/role: accessRoleForGrant\(grant\.role\),\s*centerRole: centerRoleOf\(grant\.role\)/);
  });
});

describe("oidc callback: the centre's word on a returning user", () => {
  it("is applied on every sign-in, only on a tenant console with an organisation, before the status check", () => {
    const at = ROUTE.indexOf("reconcileCenterRole(user,");
    expect(at).toBeGreaterThan(0);
    expect(ROUTE.slice(at - 300, at)).toContain("if (tenantOrg)");
    expect(at).toBeLessThan(ROUTE.indexOf('if (user.status !== "ACTIVE") return fail(req, "disabled")'));
    expect(ROUTE).toMatch(/const onTenantConsole = cfg\.isPlatform && currentTenantId\(\) !== PLATFORM_TENANT_ID/);
  });

  it("a removed member is disabled and refused; a changed role is written and the session carries it", () => {
    expect(ROUTE).toMatch(/outcome === "revoked"[\s\S]*?data: \{ status: "DISABLED" \}[\s\S]*?fail\(req, "center_revoked"\)/);
    expect(ROUTE).toMatch(/outcome === "update"[\s\S]*?user = await db\.user\.update\(\{ where: \{ id: user\.id \}, data: \{ role, centerRole, status \} \}\)/);
  });
});
