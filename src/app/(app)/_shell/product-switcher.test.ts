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
