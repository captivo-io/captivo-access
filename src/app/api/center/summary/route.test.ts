import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("@/lib/tenant/request", () => ({ withTenantRoute: (h: unknown) => h }));
vi.mock("@/lib/tenant/context", () => ({ currentTenantId: vi.fn(() => "t_acme") }));
vi.mock("@/lib/platform/sql", () => ({ tenantStats: vi.fn(), tenantSlugByOrg: vi.fn(), tenantSlugAndName: vi.fn() }));

import { GET } from "./route";
import { tenantStats, tenantSlugByOrg, tenantSlugAndName } from "@/lib/platform/sql";
import { currentTenantId } from "@/lib/tenant/context";
import { PLATFORM_TENANT_ID } from "@/lib/tenant/constants";

const SECRET = "s".repeat(32);

function req(org: string | null, secret: string | null = SECRET) {
  const url = new URL("https://acme.cloud.example/api/center/summary");
  if (org !== null) url.searchParams.set("org", org);
  return new Request(url, { headers: secret ? { "x-captivo-service": secret } : {} });
}

describe("GET /api/center/summary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("CAPTIVO_ID_SERVICE_SECRET", SECRET);
    (currentTenantId as ReturnType<typeof vi.fn>).mockReturnValue("t_acme");
    (tenantSlugAndName as ReturnType<typeof vi.fn>).mockResolvedValue({ slug: "acme", name: "Acme Ltd" });
    (tenantSlugByOrg as ReturnType<typeof vi.fn>).mockResolvedValue("acme");
    (tenantStats as ReturnType<typeof vi.fn>).mockResolvedValue(new Map([["t_acme", {
      id: "t_acme", users: 4, admins: 1, vendors: 2, sites: 3, connectors: 2, connectorsOnline: 1,
      grantsActive: 5, requestsPending: 0, auditEvents: 100, recordings: 7, recordingBytes: 1, sessions24h: 9,
      lastActivity: new Date("2026-10-20T10:00:00.000Z"),
    }]]));
  });

  it("answers the workspace's name and the facts the hub can label", async () => {
    const res = await GET(req("org_1") as never);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({
      name: "Acme Ltd",
      facts: { sites: 3, connectors: 2, connectorsOnline: 1, sessions24h: 9, lastActivity: "2026-10-20T10:00:00.000Z" },
    });
  });

  it("refuses without the shared secret, and when none is configured", async () => {
    expect((await GET(req("org_1", null) as never)).status).toBe(401);
    expect((await GET(req("org_1", "wrong") as never)).status).toBe(401);
    vi.stubEnv("CAPTIVO_ID_SERVICE_SECRET", "");
    expect((await GET(req("org_1") as never)).status).toBe(401);
    expect(tenantStats).not.toHaveBeenCalled();
  });

  it("404 when the named organisation is not the one this workspace is linked to", async () => {
    (tenantSlugByOrg as ReturnType<typeof vi.fn>).mockResolvedValue("other");
    const res = await GET(req("org_1") as never);
    expect(res.status).toBe(404);
    expect(tenantStats).not.toHaveBeenCalled();
  });

  it("400 without an org; 404 on the platform host", async () => {
    expect((await GET(req(null) as never)).status).toBe(400);
    (currentTenantId as ReturnType<typeof vi.fn>).mockReturnValue(PLATFORM_TENANT_ID);
    expect((await GET(req("org_1") as never)).status).toBe(404);
  });

  it("no stats row means empty facts, not an error", async () => {
    (tenantStats as ReturnType<typeof vi.fn>).mockResolvedValue(new Map());
    const res = await GET(req("org_1") as never);
    expect(await res.json()).toEqual({ name: "Acme Ltd", facts: {} });
  });
});
