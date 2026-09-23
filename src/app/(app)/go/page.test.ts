import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const GO = readFileSync(path.join(__dirname, "page.tsx"), "utf-8");
const TOPNAV = readFileSync(path.join(__dirname, "..", "_shell", "topnav.tsx"), "utf-8");

/**
 * Captivo remembers which product a person last entered, so a sign-in with no
 * product intent lands where they work. Using the switcher is that same
 * statement, but it is plain navigation to another host -- which this product
 * would never see. Reported on the second day: someone switched to Portal,
 * worked there, signed out, and was sent back to Access at the next sign-in.
 */
describe("leaving through the switcher records the choice", () => {
  it("the switcher links to the recording route, not straight to the other host", () => {
    expect(TOPNAV).toMatch(/href="\/go"/);
    expect(TOPNAV).not.toMatch(/href=\{p\.href\}/);
  });

  it("resolves the destination itself instead of taking it from the caller", () => {
    // Reached while signed in; a redirect to a caller-supplied address would
    // be an open redirect.
    expect(GO).toMatch(/getProductMenu\(\)[\s\S]{0,120}?item\.product === "PORTAL"/);
    expect(GO).toMatch(/redirect\(portal\.href\)/);
  });

  it("records before leaving, and awaits it", () => {
    const write = GO.indexOf('reportLastProduct(user.email, "PORTAL")');
    const leave = GO.indexOf("redirect(portal.href)");
    expect(write).toBeGreaterThan(-1);
    expect(leave).toBeGreaterThan(write);
    expect(GO).toMatch(/await reportLastProduct/);
  });

  it("goes nowhere rather than somewhere wrong when there is no Portal item", () => {
    // No entitlement, no centre, nothing to switch to: staying put beats
    // guessing an address.
    expect(GO).toMatch(/if \(!portal\?\.href\) redirect\("\/"\)/);
  });
});
