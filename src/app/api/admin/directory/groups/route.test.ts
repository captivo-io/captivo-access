import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const role = { value: "ADMIN" };
const cfg = { value: null as Record<string, unknown> | null };
vi.mock("@/lib/tenant/request", () => ({ withTenantRoute: (h: unknown) => h }));
vi.mock("@/lib/current-user", () => ({ getCurrentUser: async () => ({ id: "a1", email: "a@x", role: role.value }) }));
vi.mock("@/lib/directory/config", () => ({ getDirectoryConfig: async () => cfg.value, getDirectoryBindPassword: async () => "pw" }));
vi.mock("@/lib/connector/dataplane", () => ({ searchDirectoryGroups: vi.fn() }));

import { GET } from "./route";
import { searchDirectoryGroups } from "@/lib/connector/dataplane";

const call = (q: string) => GET(new NextRequest(`http://x/api/admin/directory/groups?q=${encodeURIComponent(q)}`));
const DIR = { enabled: true, connectorId: "c1", host: "dc", port: 389, security: "PLAIN", insecureSkipVerify: false, caCertPem: "", baseDN: "DC=corp,DC=local", bindDN: "CN=svc" };

describe("directory group search", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    role.value = "ADMIN";
    cfg.value = DIR;
  });

  it("is for admins who can configure", async () => {
    role.value = "AUDITOR";
    expect((await call("ops")).status).toBe(403);
  });

  it("asks the directory nothing for fewer than two characters", async () => {
    expect(await (await call(" o ")).json()).toEqual({ ok: true, groups: [] });
    expect(searchDirectoryGroups).not.toHaveBeenCalled();
  });

  it("says so when the directory is not set up", async () => {
    cfg.value = { ...DIR, enabled: false };
    const body = await (await call("ops")).json();
    expect(body.ok).toBe(false);
    expect(searchDirectoryGroups).not.toHaveBeenCalled();
  });

  it("returns the directory's groups", async () => {
    vi.mocked(searchDirectoryGroups).mockResolvedValue({ groups: [{ name: "DB-Ops", dn: "CN=DB-Ops,DC=corp,DC=local" }], truncated: true });
    const body = await (await call("ops")).json();
    expect(body).toEqual({ ok: true, groups: [{ name: "DB-Ops", dn: "CN=DB-Ops,DC=corp,DC=local" }], truncated: true });
    expect(vi.mocked(searchDirectoryGroups).mock.calls[0][0]).toMatchObject({ connectorId: "c1", query: "ops", bindPassword: "pw" });
  });

  it("passes a directory error on", async () => {
    vi.mocked(searchDirectoryGroups).mockResolvedValue({ groups: [], error: "The directory did not answer in time." });
    expect(await (await call("ops")).json()).toEqual({ ok: false, groups: [], error: "The directory did not answer in time." });
  });
});
