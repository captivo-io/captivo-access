import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { planUsageText } from "./plan-usage";

describe("allowance line", () => {
  it("states the allowance as a fact below the cap", () => {
    expect(planUsageText({ used: 2, max: 5, plan: "free" }, "resources"))
      .toBe("Free plan: 2 of 5 resources used");
  });

  it("says what to do only AT the cap", () => {
    // A line that warns at every count teaches people to ignore it; the next
    // click only fails once the cap is reached.
    const below = planUsageText({ used: 4, max: 5, plan: "free" }, "resources");
    const at = planUsageText({ used: 5, max: 5, plan: "free" }, "resources");
    expect(below).not.toContain("upgrade");
    expect(at).toContain("remove one or upgrade");
  });

  it("does not call a paid plan free", () => {
    expect(planUsageText({ used: 1, max: 3, plan: "standard" }, "connectors"))
      .toBe("Your plan: 1 of 3 connectors used");
    expect(planUsageText({ used: 1, max: 3, plan: null }, "connectors"))
      .toContain("Your plan");
  });

  it("treats over-cap as at-cap rather than going quiet", () => {
    // A limit lowered from the platform console can leave a workspace above
    // it. Reading `used > max` as "below the cap" would hide exactly the state
    // that needs explaining.
    expect(planUsageText({ used: 7, max: 5, plan: "free" }, "resources"))
      .toContain("remove one or upgrade");
  });
});

describe("what the pages count", () => {
  const CONN = readFileSync(path.join(__dirname, "..", "..", "app", "(app)", "admin", "connectors", "page.tsx"), "utf-8");
  const SITES = readFileSync(path.join(__dirname, "..", "..", "app", "(app)", "admin", "sites", "page.tsx"), "utf-8");
  const API_CONN = readFileSync(path.join(__dirname, "..", "..", "app", "api", "admin", "connectors", "route.ts"), "utf-8");

  it("counts connectors the way the gate counts them", () => {
    // The gate excludes REVOKED. A page that counted them too would show an
    // allowance already spent while the gate still let another one through --
    // the two numbers must come from the same rule.
    expect(API_CONN).toMatch(/status: \{ not: "REVOKED" \}/);
    expect(CONN).toMatch(/planUsage\(\s*"maxConnectors",[\s\S]{0,160}?status: \{ not: "REVOKED" \}/);
  });

  it("reuses the resource list already loaded instead of a second query", () => {
    expect(SITES).toMatch(/planUsage\("maxSites", sites\.length\)/);
  });

  it("renders the note on both pages", () => {
    expect(CONN).toMatch(/<PlanUsageNote usage=\{connectorUsage\} noun="connectors" \/>/);
    expect(SITES).toMatch(/<PlanUsageNote usage=\{siteUsage\} noun="resources" \/>/);
  });
});
