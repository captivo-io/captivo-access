import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchAccessEntitlement, reportTenantLink, fetchCenterPicture } from "./captivo-id-client";

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
    expect(await fetchAccessEntitlement("org_1", env)).toEqual({
      status: "ok", plan: "free", limits: { maxConnectors: 1, maxSites: 5 }, expiresAt: null,
    });
  });

  it("carries the expiry through instead of discarding it", async () => {
    // Read off the wire and then dropped, an expired entitlement provisioned a
    // workspace exactly like a live one. The caller cannot refuse what it is
    // never told.
    mockFetch(200, { entitlements: [
      { product: "ACCESS", plan: "free", limits: null, expiresAt: "2026-01-31T00:00:00.000Z" },
    ] });
    expect(await fetchAccessEntitlement("org_1", env)).toEqual({
      status: "ok", plan: "free", limits: null, expiresAt: "2026-01-31T00:00:00.000Z",
    });
  });

  it("sends the service secret and the organisation", async () => {
    const f = mockFetch(200, { entitlements: [] });
    await fetchAccessEntitlement("org_1", env);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/api/entitlements");
    expect(url).toContain("org=org_1");
    expect((init.headers as Record<string, string>)["X-Captivo-Service"]).toBe(env.CAPTIVO_ID_SERVICE_SECRET);
  });

  it("reports a genuine absence of entitlement as \"none\"", async () => {
    mockFetch(200, { entitlements: [{ product: "PORTAL", plan: null, limits: null, expiresAt: null }] });
    expect(await fetchAccessEntitlement("org_1", env)).toEqual({ status: "none" });
  });

  it("reports an unreachable centre as unavailable, NOT as an absence of entitlement", async () => {
    // These are opposite facts. Answering "none" here told someone who had
    // just presented a valid grant that their organisation was not entitled.
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));
    expect(await fetchAccessEntitlement("org_1", env)).toEqual({ status: "unavailable", reason: "unreachable" });
  });

  it("reports a non-2xx answer as unavailable", async () => {
    // A 500, or a 401 from a rotated service secret, says nothing at all about
    // the organisation's entitlement.
    mockFetch(500, {});
    expect(await fetchAccessEntitlement("org_1", env)).toEqual({ status: "unavailable", reason: "bad_response" });
  });

  it("reports an unconfigured service as unavailable without calling out", async () => {
    const f = mockFetch(200, { entitlements: [] });
    expect(await fetchAccessEntitlement("org_1", { CAPTIVO_ID_ISSUER: "https://id.captivo.io" }))
      .toEqual({ status: "unavailable", reason: "not_configured" });
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

describe("fetchCenterPicture", () => {
  // `env` and `mockFetch` are the file's own; `afterEach` there already calls
  // vi.unstubAllGlobals(), so nothing here needs its own teardown.

  it("returns both products and their bridges", async () => {
    mockFetch(200, {
      entitlements: [
        { product: "PORTAL", plan: null, limits: null, expiresAt: null },
        { product: "ACCESS", plan: "free", limits: { maxSites: 5 }, expiresAt: null },
      ],
      links: [{ product: "ACCESS", tenantId: "t_1", consoleOrigin: "https://acme.cloud.captivo.io" }],
    });
    const out = await fetchCenterPicture("org_1", 900, env);
    expect(out?.entitlements.map((e) => e.product)).toEqual(["PORTAL", "ACCESS"]);
    expect(out?.links).toEqual([{ product: "ACCESS", tenantId: "t_1", consoleOrigin: "https://acme.cloud.captivo.io" }]);
  });

  it("drops unusable rows instead of failing the whole read", async () => {
    // The wire is not the type. A row that is not an object with a string
    // `product` kills the first consumer that reads `.product` off it, and that
    // consumer renders in the console's layout -- so one bad row would cost the
    // whole console. One bad row must also not cost the products that are fine.
    mockFetch(200, {
      entitlements: [null, "ACCESS", { product: 42 }, { product: "PORTAL", plan: null, limits: null, expiresAt: null }],
      links: [null, { product: "ACCESS", tenantId: "t_1", consoleOrigin: null }],
    });
    const out = await fetchCenterPicture("org_1", 900, env);
    expect(out?.entitlements.map((e) => e.product)).toEqual(["PORTAL"]);
    expect(out?.links).toEqual([{ product: "ACCESS", tenantId: "t_1", consoleOrigin: null }]);
  });

  it("returns null when the centre is not configured", async () => {
    // A self-hosted installation has no route to the centre and must not try.
    const spy = mockFetch(200, { entitlements: [], links: [] });
    expect(await fetchCenterPicture("org_1", 900, {})).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it("returns null for a non-2xx, a body that is not an object, and a thrown fetch", async () => {
    // "The centre did not answer" and "the centre says nothing is entitled" are
    // opposite facts; only the first may be null here.
    mockFetch(500, {});
    expect(await fetchCenterPicture("org_1", 900, env)).toBeNull();
    mockFetch(200, "hello");
    expect(await fetchCenterPicture("org_1", 900, env)).toBeNull();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));
    expect(await fetchCenterPicture("org_1", 900, env)).toBeNull();
  });

  it("carries the caller's deadline to the request", async () => {
    const spy = mockFetch(200, { entitlements: [], links: [] });
    await fetchCenterPicture("org_1", 900, env);
    const [, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});
