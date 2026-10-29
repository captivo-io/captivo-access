import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/settings/platform", () => ({ getPlatformSettings: vi.fn(), saveDisplayTimezone: vi.fn() }));
const { grantTimeZone } = await import("./center-time-zone");

const ROOT = path.join(__dirname, "..", "..");
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf-8");

describe("workspace display zone from Captivo ID", () => {
  const claims = (grants: unknown[]) => ({ captivo: { grants } }) as never;

  it("reads the zone from this organisation's ACCESS grant only", () => {
    const c = claims([
      { product: "PORTAL", org: "o1", orgName: "Acme", role: "OWNER", timeZone: "Asia/Dubai" },
      { product: "ACCESS", org: "o2", orgName: "Other", role: "OWNER", timeZone: "Europe/Berlin" },
      { product: "ACCESS", org: "o1", orgName: "Acme", role: "OWNER", timeZone: "America/New_York" },
    ]);
    expect(grantTimeZone(c, "o1")).toBe("America/New_York");
    expect(grantTimeZone(c, "o3")).toBeNull();
  });

  it("ignores a missing or unknown zone", () => {
    expect(grantTimeZone(claims([{ product: "ACCESS", org: "o1", orgName: "Acme", role: "OWNER" }]), "o1")).toBeNull();
    expect(grantTimeZone(claims([{ product: "ACCESS", org: "o1", orgName: "Acme", role: "OWNER", timeZone: "Mars/Olympus" }]), "o1")).toBeNull();
    expect(grantTimeZone({} as never, "o1")).toBeNull();
  });

  it("is applied at sign-in before provisioning, pushed by the centre, and locked on the policy page", () => {
    const cb = read("app/api/auth/oidc/callback/route.ts");
    const apply = cb.indexOf("applyCenterTimeZone(zone)");
    expect(apply).toBeGreaterThan(-1);
    expect(cb.indexOf("db.user.findFirst(")).toBeGreaterThan(apply);
    const push = read("app/api/center/settings/route.ts");
    expect(push).toContain("secretMatches(given, expected)");
    expect(push).toMatch(/tenantSlugByOrg\(org\)\) !== tenant\.slug/);
    expect(read("app/api/admin/policy/platform/route.ts")).toMatch(/displayTimezone: zoneManaged\s*\? \(await getPlatformSettings\(\)\)\.displayTimezone/);
  });
});
