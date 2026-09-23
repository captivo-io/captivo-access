import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { validateCreateInput, validateUpdateInput, PlatformError } from "./tenants";

describe("validateCreateInput", () => {
  it("accepts a clean input", () => {
    expect(() => validateCreateInput({ name: "Acme", slug: "acme", adminEmail: "a@acme.co" })).not.toThrow();
  });
  it("rejects a reserved/invalid slug", () => {
    expect(() => validateCreateInput({ name: "X", slug: "platform", adminEmail: "a@b.co" })).toThrow(PlatformError);
    expect(() => validateCreateInput({ name: "X", slug: "Bad_Slug", adminEmail: "a@b.co" })).toThrow(/invalid_slug/);
  });
  it("rejects an empty name", () => {
    expect(() => validateCreateInput({ name: "  ", slug: "acme", adminEmail: "a@b.co" })).toThrow(/invalid_name/);
  });
  it("rejects a malformed email", () => {
    expect(() => validateCreateInput({ name: "Acme", slug: "acme", adminEmail: "nope" })).toThrow(/invalid_email/);
  });
});

describe("validateUpdateInput", () => {
  const base = { name: "Acme", plan: "standard", trialEndsAt: null, limits: {}, capabilities: {}, notes: null };
  it("normalizes a valid update", () => {
    const v = validateUpdateInput({ ...base, name: "  Acme Inc ", plan: "enterprise", trialEndsAt: new Date("2026-10-01T00:00:00Z"), limits: { maxUsers: "5" }, capabilities: { vault: false }, notes: "  hi " });
    expect(v).toMatchObject({ name: "Acme Inc", plan: "enterprise", limits: { maxUsers: 5 }, capabilities: { vault: false }, notes: "hi" });
    // Dropped whatever the caller sent: no plan expires any more, so the
    // column is never written. It is KEPT in the schema because removing it
    // would be a data-loss migration for a field nothing writes.
    expect(v.trialEndsAt).toBeNull();
  });
  it("drops the trial end on every plan", () => {
    for (const plan of ["standard", "enterprise", "free"]) {
      expect(validateUpdateInput({ ...base, plan, trialEndsAt: new Date() }).trialEndsAt).toBeNull();
    }
  });
  it("rejects an empty name and an unknown plan — 'trial' now among them", () => {
    expect(() => validateUpdateInput({ ...base, name: " " })).toThrow(PlatformError);
    expect(() => validateUpdateInput({ ...base, plan: "gold" })).toThrow(/invalid_plan/);
    expect(() => validateUpdateInput({ ...base, plan: "trial" })).toThrow(/invalid_plan/);
  });
});

describe("createTenant caps", () => {
  const SRC = readFileSync(path.join(__dirname, "tenants.ts"), "utf-8");

  it("accepts limits in its input", () => {
    // Exercising createTenant for real needs a database and an RLS bootstrap,
    // which this suite does not have; the behaviour is covered by the
    // provisioning flow's tests. What is asserted here is the contract a
    // caller depends on, so a silently dropped parameter is caught.
    expect(SRC).toMatch(/limits\?:\s*TenantLimits/);
  });

  it("passes the caps through instead of hard-coding null", () => {
    // The call used to write `limits: null` unconditionally. A free tenant
    // whose caps were dropped on the floor would let anyone add unlimited
    // connectors -- the tier's only enforcement is that row.
    const call = SRC.slice(SRC.indexOf("export async function createTenant"));
    expect(call).not.toMatch(/updateTenantRow\(\{[^}]*limits:\s*null/);
  });
});

describe("createTenant leaves nothing half made", () => {
  const SRC = readFileSync(path.join(__dirname, "tenants.ts"), "utf-8");
  const SQL_SRC = readFileSync(path.join(__dirname, "sql.ts"), "utf-8");
  const body = SRC.slice(SRC.indexOf("export async function createTenant"));

  it("undoes the tenant row when a later step throws", () => {
    // The row is written first and the plan, the caps, the first invite and
    // the platform defaults follow. A throw in any of those used to leave a
    // live workspace on the wrong plan with no caps, no invite anyone had
    // seen, and no way in -- while still holding the slug, so retrying at the
    // same address answered "already in use".
    expect(body).toMatch(/catch[\s\S]{0,400}?rollbackCreatedTenantRow\(id\)/);
  });

  it("rethrows the original failure rather than the rollback's", () => {
    // The caller decides what to tell the person from the error it gets. If a
    // failed rollback replaced it, every one of those answers would describe
    // the cleanup instead of the cause.
    const undo = body.indexOf("rollbackCreatedTenantRow(id)");
    const rethrow = body.indexOf("throw e;", undo);
    expect(rethrow).toBeGreaterThan(undo);
    // And the rollback's own failure is caught, not allowed to escape.
    expect(body.slice(undo, rethrow)).toMatch(/catch \(undoError\)/);
  });

  it("covers the first invite, not only the plan write", () => {
    // A tenant whose invite never got written is as unreachable as one whose
    // plan never got applied; the guard has to start above createInvite.
    //
    // Matched as a chain rather than by comparing two indexOf positions: the
    // insert has a try of its own, higher up, so `indexOf("try {")` finds THAT
    // one and the comparison passes no matter where the guard actually
    // starts. The first version of this test did exactly that and proved
    // nothing.
    expect(body).toMatch(
      /let token: string;\s*try \{[\s\S]*?createInvite\([\s\S]*?catch[\s\S]{0,400}?rollbackCreatedTenantRow/,
    );
  });

  it("takes the row back in one transaction", () => {
    // Purge refuses a row that was not soft-deleted first, so the rollback is
    // two calls. Halfway through leaves the tenant invisible to every
    // resolver while still holding its slug in the unique index -- the person
    // could not even retry at the address they just chose.
    const fn = SQL_SRC.slice(SQL_SRC.indexOf("export async function rollbackCreatedTenantRow"));
    expect(fn).toMatch(/\$transaction\([\s\S]{0,400}?platform_delete_tenant[\s\S]{0,400}?platform_purge_tenant/);
  });
});
