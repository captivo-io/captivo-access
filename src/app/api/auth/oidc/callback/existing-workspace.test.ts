import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const SRC = readFileSync(path.join(__dirname, "route.ts"), "utf-8");

/**
 * Someone whose organisation already has a workspace was shown the address
 * form on the platform host, typed the address they had already chosen, and
 * was told at the submit that it was taken -- by themselves. The manager's
 * hosts comment in the Portal repository claimed this forwarding existed; it
 * did not, and a login landing rule was built on that claim.
 */
describe("the platform host does not offer a workspace that exists", () => {
  it("looks the organisation up before offering creation", () => {
    const lookup = SRC.indexOf("tenantSlugByOrg(grant.org)");
    const offer = SRC.indexOf("/workspace/new");
    expect(lookup).toBeGreaterThan(-1);
    expect(lookup).toBeLessThan(offer);
  });

  it("sends them to that console instead", () => {
    expect(SRC).toMatch(/return NextResponse\.redirect\(`https:\/\/\$\{existingSlug\}\.\$\{domain\}`\)/);
  });

  it("still offers creation when there is genuinely no workspace", () => {
    // Both conditions, not just the slug: without a console domain there is no
    // address to send anyone to, and creation is the only useful answer left.
    expect(SRC).toMatch(/if \(existingSlug && domain\)/);
    expect(SRC).toMatch(/\/workspace\/new/);
  });
});
