import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const SETUP = readFileSync(path.join(__dirname, "page.tsx"), "utf-8");
const LOGIN = readFileSync(path.join(__dirname, "..", "login", "page.tsx"), "utf-8");

/**
 * A freshly provisioned cloud workspace has an invited admin and no user yet.
 * /login read only "are there users?" and sent that person to the first-run
 * wizard -- which the registration endpoints refuse on a tenant host, because
 * tenant admins arrive by invitation. The console was a dead end: the wizard
 * could not finish, and the SSO button that WOULD have let the invited admin
 * in lived on the page nobody could reach.
 */
describe("first-run is only offered where first-run can work", () => {
  it("makes /login's redirect conditional on the setup gate, not just on user count", () => {
    expect(LOGIN).toMatch(/hasAnyUser\(\)\)\s*&&\s*resolveSetupRole\(\)\.allowed\)\s*redirect\("\/setup"\)/);
  });

  it("sends /setup away where it is not allowed", () => {
    expect(SETUP).toMatch(/if \(!resolveSetupRole\(\)\.allowed\) redirect\("\/login"\)/);
  });

  it("checks that gate BEFORE asking whether users exist", () => {
    // Order is the point on a tenant host: the user count is a tenant-scoped
    // query, and answering "no users, show the wizard" first is exactly the
    // dead end this file exists to prevent.
    const gate = SETUP.indexOf("resolveSetupRole()");
    // The CALL, not the import line -- `indexOf("hasAnyUser()")` finds the
    // import first and makes this assertion measure nothing.
    const count = SETUP.indexOf("await hasAnyUser()");
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(count);
  });

  it("runs /setup inside the request's tenant scope", () => {
    // resolveSetupRole reads currentTenantId(), which is the async-local
    // scope, NOT the per-query auto-scope the db proxy applies. Unwrapped it
    // answers "default" on every host -- which would refuse first-run on the
    // platform console, where it is the only way to create the first
    // super-admin.
    expect(SETUP).toMatch(/withRequestTenant\(\(\) => SetupPageImpl\(\)\)/);
  });
});
