import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { PLANS } from "./tenant-shape";

const SQL = readFileSync(
  path.join(__dirname, "..", "..", "..", "prisma", "rls", "bootstrap.sql"),
  "utf-8",
);

/**
 * The plan name lives in two places that cannot import each other: the
 * TypeScript union and an allow-list inside a SECURITY DEFINER function. They
 * drifted -- "free" was added to the product and never to the SQL -- and the
 * result was not a rejected request but a HALF-CREATED workspace: the tenant
 * row and its first invite existed, the plan and the free tier's caps did not,
 * and the call died before it could tell the identity service where the new
 * console lives, so nobody could sign in to it.
 */
describe("plan names agree between TypeScript and the database", () => {
  const listed = SQL.match(/p_plan NOT IN \(([^)]*)\)/);

  it("has an allow-list to compare against", () => {
    expect(listed, "platform_update_tenant no longer guards p_plan").not.toBeNull();
  });

  it("accepts exactly the plans the product defines", () => {
    const inSql = [...listed![1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    // Sorted: the order in either list carries no meaning.
    expect([...inSql].sort()).toEqual([...PLANS].sort());
  });

  it("accepts the free tier, whose provisioning path is the one that broke", () => {
    // Named on its own so a regression reads as itself rather than as a
    // set-difference nobody parses at a glance.
    expect(listed![1]).toContain("'free'");
  });
});
