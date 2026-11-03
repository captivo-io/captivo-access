import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("@/lib/tenant/internal", () => ({
  requireDataplaneSecret: (h: unknown) => h,
  resolveTenantByUser: vi.fn(),
  withTenantFrom: () => (h: unknown) => h,
}));
const userFindUnique = vi.fn();
const siteFindUnique = vi.fn();
vi.mock("@/lib/db", () => ({
  db: {
    user: { findUnique: (...a: unknown[]) => userFindUnique(...a) },
    site: { findUnique: (...a: unknown[]) => siteFindUnique(...a) },
  },
}));

import { POST } from "./route";

const SECRET = "d".repeat(32);
function req(body: unknown) {
  return new Request("http://manager/api/internal/gateway/view-authz", {
    method: "POST",
    headers: { "content-type": "application/json", "x-dataplane-secret": SECRET },
    body: JSON.stringify(body),
  });
}

describe("POST /api/internal/gateway/view-authz", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("DATAPLANE_SECRET", SECRET);
    userFindUnique.mockResolvedValue({ role: "AUDITOR" });
    siteFindUnique.mockResolvedValue({ id: "site_own" });
  });

  it("a console reader may watch a session on their own tenant's site", async () => {
    expect(await (await POST(req({ userId: "u1", siteId: "site_own" }) as never)).json()).toEqual({ allow: true });
  });

  it("a site outside the viewer's tenant is refused", async () => {
    siteFindUnique.mockResolvedValue(null);
    expect(await (await POST(req({ userId: "u1", siteId: "site_other" }) as never)).json()).toEqual({ allow: false });
  });

  it("a request without the site is refused (an old data plane fails closed)", async () => {
    expect(await (await POST(req({ userId: "u1" }) as never)).json()).toEqual({ allow: false });
  });

  it("a vendor is refused even on an own site", async () => {
    userFindUnique.mockResolvedValue({ role: "VENDOR" });
    expect(await (await POST(req({ userId: "u1", siteId: "site_own" }) as never)).json()).toEqual({ allow: false });
  });
});
