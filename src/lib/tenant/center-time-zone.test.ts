import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const findTenant = vi.fn();
const fromCenter = vi.fn();
const getSettings = vi.fn();
const save = vi.fn();
vi.mock("@/lib/db", () => ({ db: { tenant: { findUnique: (...a: unknown[]) => findTenant(...a) } } }));
vi.mock("@/lib/tenant/context", () => ({ currentTenantId: () => "t1" }));
vi.mock("@/lib/auth/captivo-id-client", () => ({ captivoAccountUrl: () => "https://id.captivo.io/account" }));
vi.mock("@/lib/settings/platform", () => ({
  getPlatformSettings: (...a: unknown[]) => getSettings(...a),
  saveDisplayTimezone: (...a: unknown[]) => save(...a),
  displayTimezoneFromCenter: (...a: unknown[]) => fromCenter(...a),
}));
const { grantTimeZone, timeZoneManaged, applyCenterTimeZone } = await import("./center-time-zone");

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

  it("stays editable for a linked workspace until the organisation has sent a zone", async () => {
    findTenant.mockResolvedValue({ captivoOrgId: "o1" });
    fromCenter.mockResolvedValueOnce(false);
    expect(await timeZoneManaged()).toBe(false);
    fromCenter.mockResolvedValueOnce(true);
    expect(await timeZoneManaged()).toBe(true);
    findTenant.mockResolvedValue({ captivoOrgId: null });
    expect(await timeZoneManaged()).toBe(false);
  });

  it("records the first zone from the centre even when it equals the current one", async () => {
    getSettings.mockResolvedValue({ displayTimezone: "Europe/Istanbul" });
    fromCenter.mockResolvedValueOnce(false);
    expect(await applyCenterTimeZone("Europe/Istanbul")).toBe(true);
    expect(save).toHaveBeenCalledWith("Europe/Istanbul");
    save.mockClear();
    fromCenter.mockResolvedValueOnce(true);
    expect(await applyCenterTimeZone("Europe/Istanbul")).toBe(false);
    expect(save).not.toHaveBeenCalled();
  });
});
