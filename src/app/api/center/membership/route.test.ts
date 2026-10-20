import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("@/lib/tenant/request", () => ({ withTenantRoute: (h: unknown) => h }));
vi.mock("@/lib/tenant/context", () => ({ currentTenantId: vi.fn(() => "t_acme") }));
vi.mock("@/lib/platform/sql", () => ({ tenantSlugByOrg: vi.fn(), tenantSlugAndName: vi.fn() }));
const userFindFirst = vi.fn();
const userUpdate = vi.fn();
const sessionDeleteMany = vi.fn();
vi.mock("@/lib/db", () => ({ db: { user: { findFirst: (...a: unknown[]) => userFindFirst(...a), update: (...a: unknown[]) => userUpdate(...a) }, session: { deleteMany: (...a: unknown[]) => sessionDeleteMany(...a) } } }));

import { POST } from "./route";
import { tenantSlugByOrg, tenantSlugAndName } from "@/lib/platform/sql";
import { currentTenantId } from "@/lib/tenant/context";

const SECRET = "s".repeat(32);

function req(body: unknown, secret: string | null = SECRET) {
  return new Request("https://acme.cloud.example/api/center/membership", {
    method: "POST",
    headers: { "content-type": "application/json", ...(secret ? { "x-captivo-service": secret } : {}) },
    body: JSON.stringify(body),
  });
}

describe("POST /api/center/membership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("CAPTIVO_ID_SERVICE_SECRET", SECRET);
    (currentTenantId as ReturnType<typeof vi.fn>).mockReturnValue("t_acme");
    (tenantSlugAndName as ReturnType<typeof vi.fn>).mockResolvedValue({ slug: "acme", name: "Acme Ltd" });
    (tenantSlugByOrg as ReturnType<typeof vi.fn>).mockResolvedValue("acme");
    userUpdate.mockResolvedValue({});
    sessionDeleteMany.mockResolvedValue({ count: 1 });
  });

  it("a removed member is disabled and signed out everywhere", async () => {
    userFindFirst.mockResolvedValue({ id: "u1", role: "ADMIN", centerRole: "ADMIN", status: "ACTIVE" });
    const res = await POST(req({ org: "org_1", email: "Ayse@Acme.test", role: null }) as never);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ applied: true, outcome: "revoked" });
    expect(userUpdate).toHaveBeenCalledWith({ where: { id: "u1" }, data: { status: "DISABLED" } });
    expect(sessionDeleteMany).toHaveBeenCalledWith({ where: { userId: "u1" } });
  });

  it("a changed role is mapped and the sessions end; the same role changes nothing", async () => {
    userFindFirst.mockResolvedValue({ id: "u1", role: "STAFF", centerRole: "MEMBER", status: "ACTIVE" });
    expect(await (await POST(req({ org: "org_1", email: "a@b.c", role: "OWNER" }) as never)).json()).toEqual({ applied: true, outcome: "update" });
    expect(userUpdate).toHaveBeenCalledWith({ where: { id: "u1" }, data: { role: "ADMIN", centerRole: "OWNER", status: "ACTIVE" } });
    userUpdate.mockClear(); sessionDeleteMany.mockClear();
    expect(await (await POST(req({ org: "org_1", email: "a@b.c", role: "MEMBER" }) as never)).json()).toEqual({ applied: false });
    expect(sessionDeleteMany).not.toHaveBeenCalled();
  });

  it("local and passkey accounts are left alone; wrong organisation 404; no secret 401; platform host 404", async () => {
    userFindFirst.mockResolvedValue({ id: "u1", role: "ADMIN", centerRole: null, status: "ACTIVE" });
    expect(await (await POST(req({ org: "org_1", email: "a@b.c", role: null }) as never)).json()).toEqual({ applied: false });
    (tenantSlugByOrg as ReturnType<typeof vi.fn>).mockResolvedValue("other");
    expect((await POST(req({ org: "org_1", email: "a@b.c", role: null }) as never)).status).toBe(404);
    expect((await POST(req({ org: "org_1", email: "a@b.c", role: null }, null) as never)).status).toBe(401);
    expect((await POST(req({ org: "org_1" }) as never)).status).toBe(400);
    (currentTenantId as ReturnType<typeof vi.fn>).mockReturnValue("platform");
    expect((await POST(req({ org: "org_1", email: "a@b.c", role: null }) as never)).status).toBe(404);
  });
});
