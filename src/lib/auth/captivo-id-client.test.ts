import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchAccessEntitlement, reportTenantLink } from "./captivo-id-client";

const env = {
  CAPTIVO_ID_ISSUER: "https://id.captivo.io",
  CAPTIVO_ID_SERVICE_SECRET: "s".repeat(32),
};

function mockFetch(status: number, body: unknown) {
  const f = vi.fn(async () => ({ ok: status >= 200 && status < 300, status, json: async () => body }));
  vi.stubGlobal("fetch", f);
  return f;
}

afterEach(() => vi.unstubAllGlobals());

describe("fetchAccessEntitlement", () => {
  it("returns the ACCESS entitlement's tier and caps", async () => {
    mockFetch(200, { entitlements: [
      { product: "PORTAL", plan: null, limits: null, expiresAt: null },
      { product: "ACCESS", plan: "free", limits: { maxConnectors: 1, maxSites: 5 }, expiresAt: null },
    ] });
    expect(await fetchAccessEntitlement("org_1", env)).toEqual({ plan: "free", limits: { maxConnectors: 1, maxSites: 5 } });
  });

  it("sends the service secret and the organisation", async () => {
    const f = mockFetch(200, { entitlements: [] });
    await fetchAccessEntitlement("org_1", env);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/api/entitlements");
    expect(url).toContain("org=org_1");
    expect((init.headers as Record<string, string>)["X-Captivo-Service"]).toBe(env.CAPTIVO_ID_SERVICE_SECRET);
  });

  it("returns null when the organisation has no ACCESS entitlement", async () => {
    mockFetch(200, { entitlements: [{ product: "PORTAL", plan: null, limits: null, expiresAt: null }] });
    expect(await fetchAccessEntitlement("org_1", env)).toBeNull();
  });

  it("returns null when the centre is unreachable, without throwing", async () => {
    // A workspace must not be created against guessed caps, but a network
    // blip must not surface as a stack trace to the person signing in.
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));
    expect(await fetchAccessEntitlement("org_1", env)).toBeNull();
  });

  it("returns null when the service is not configured", async () => {
    const f = mockFetch(200, { entitlements: [] });
    expect(await fetchAccessEntitlement("org_1", { CAPTIVO_ID_ISSUER: "https://id.captivo.io" })).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });
});

describe("reportTenantLink", () => {
  it("posts the link with the console origin", async () => {
    const f = mockFetch(201, { ok: true });
    const ok = await reportTenantLink({ organizationId: "org_1", tenantId: "t_1", consoleOrigin: "https://acme.cloud.captivo.io" }, env);
    expect(ok).toBe(true);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/api/tenant-link");
    expect(JSON.parse(init.body as string)).toEqual({
      organizationId: "org_1", product: "ACCESS", tenantId: "t_1", consoleOrigin: "https://acme.cloud.captivo.io",
    });
  });

  it("reports failure instead of throwing when the centre refuses", async () => {
    // The workspace already exists by the time this runs; a refusal must be
    // visible to the caller, not fatal to the person standing in front of it.
    mockFetch(400, { error: "invalid_console_origin" });
    expect(await reportTenantLink({ organizationId: "org_1", tenantId: "t_1", consoleOrigin: "https://nope.example" }, env)).toBe(false);
  });

  it("reports failure when the centre is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));
    expect(await reportTenantLink({ organizationId: "org_1", tenantId: "t_1", consoleOrigin: "https://acme.cloud.captivo.io" }, env)).toBe(false);
  });
});
