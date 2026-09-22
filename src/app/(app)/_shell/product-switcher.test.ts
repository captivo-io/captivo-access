import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

const read = (...p: string[]) => readFileSync(path.join(__dirname, ...p), "utf-8");
const NAV = read("topnav.tsx");
const LAYOUT = read("..", "layout.tsx");

describe("the switcher is wired into the console", () => {
  it("the layout fetches the menu and hands it to the nav", () => {
    expect(LAYOUT).toMatch(/getProductMenu\(\)/);
    expect(LAYOUT).toMatch(/products=\{/);
  });

  it("the layout calls it INSIDE the tenant scope, not in the wrapper", () => {
    // The one mistake here looks like success. getProductMenu() ends up reading
    // currentTenantId(), which only resolves the real tenant inside the scope
    // that the exported wrapper opens around AppLayoutImpl. Move the call up
    // into that wrapper and currentTenantId() returns "default": the wrong
    // tenant is queried, with no error, no type failure and no crash.
    //
    // Asserting the call merely APPEARS in the file cannot see that move, so
    // this reads the implementation's body and asserts it is in there.
    // Both anchors are literal text in another file. If either is renamed,
    // indexOf answers -1, slice(start, -1) hands back nearly the whole file,
    // and this guard passes while guarding nothing -- which is the same class
    // of silent pass it was written to close. So assert they were found first:
    // a rename then fails here loudly and gets a new anchor.
    const start = LAYOUT.indexOf("async function AppLayoutImpl");
    const end = LAYOUT.indexOf("export default async function AppLayout");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);

    const body = LAYOUT.slice(start, end);
    expect(body).toContain("getProductMenu()");
  });

  it("the nav renders nothing when there is no menu", () => {
    // Self-hosted, no organisation, a silent centre and a single-product
    // organisation all arrive as an empty list.
    expect(NAV).toMatch(/products\.length\s*>\s*0/);
  });

  it("the nav reuses the existing menu machinery rather than a second one", () => {
    // A second dropdown would bring its own outside-click handling and could
    // sit open at the same time as the account menu.
    expect(NAV).toMatch(/open === "products"/);
  });

  it("a product that needs setup is labelled, not just styled", () => {
    expect(NAV).toMatch(/Needs setup/);
  });
});
