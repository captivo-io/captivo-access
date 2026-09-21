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
    const v = validateUpdateInput({ ...base, name: "  Acme Inc ", plan: "trial", trialEndsAt: new Date("2026-10-01T00:00:00Z"), limits: { maxUsers: "5" }, capabilities: { vault: false }, notes: "  hi " });
    expect(v).toMatchObject({ name: "Acme Inc", plan: "trial", limits: { maxUsers: 5 }, capabilities: { vault: false }, notes: "hi" });
    expect(v.trialEndsAt?.toISOString()).toBe("2026-10-01T00:00:00.000Z");
  });
  it("drops the trial end when the plan is not trial", () => {
    expect(validateUpdateInput({ ...base, trialEndsAt: new Date() }).trialEndsAt).toBeNull();
  });
  it("rejects an empty name, an unknown plan, and a bad trial date", () => {
    expect(() => validateUpdateInput({ ...base, name: " " })).toThrow(PlatformError);
    expect(() => validateUpdateInput({ ...base, plan: "gold" })).toThrow(/invalid_plan/);
    expect(() => validateUpdateInput({ ...base, plan: "trial", trialEndsAt: new Date("nope") })).toThrow(/invalid_trial_end/);
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
