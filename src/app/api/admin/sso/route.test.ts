import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({
  user: { id: "u1", email: "a@acme.test", role: "admin" } as { id: string; email: string; role: string } | null,
  saved: [] as unknown[],
  removed: 0,
  audit: [] as string[],
}));
vi.mock("@/lib/current-user", () => ({ getCurrentUser: async () => h.user }));
vi.mock("@/lib/auth/roles", () => ({ can: (role: string) => role === "admin" }));
vi.mock("@/lib/audit/admin", () => ({ recordAdminAction: async (a: { action: string }) => { h.audit.push(a.action); } }));
vi.mock("@/lib/tenant/request", () => ({ withTenantRoute: <T,>(f: T) => f }));
vi.mock("@/lib/auth/oidc-config", () => ({
  saveOidcConfig: async (c: unknown) => { h.saved.push(c); },
  deleteOidcConfig: async () => { h.removed++; return true; },
  getOidcConfig: async () => ({ hasSecret: false }),
}));

import { POST, DELETE } from "./route";

const post = (body: Record<string, unknown>) => POST(new NextRequest("https://acme.cloud.captivo.io/api/admin/sso", { method: "POST", body: JSON.stringify(body) }));

describe("SSO settings route", () => {
  beforeEach(() => {
    h.user = { id: "u1", email: "a@acme.test", role: "admin" };
    h.saved = []; h.removed = 0; h.audit = [];
    vi.stubEnv("CAPTIVO_DEPLOYMENT", "saas");
    vi.stubEnv("CAPTIVO_ID_ISSUER", "https://id.captivo.io");
    vi.stubEnv("CAPTIVO_ID_CLIENT_ID", "captivo-access");
    vi.stubEnv("CAPTIVO_ID_CLIENT_SECRET", "s3cret");
  });

  it("refuses Captivo ID's own issuer as the tenant's provider", async () => {
    // What the prefilled page used to save: Captivo ID's values, no secret.
    const r = await post({ enabled: true, issuer: "https://id.captivo.io/", clientId: "captivo-access" });
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: "captivo_id_issuer" });
    expect(h.saved).toEqual([]);
  });

  it("still saves a real provider", async () => {
    const r = await post({ enabled: false, issuer: "https://acme.okta.com", clientId: "abc" });
    expect(r.status).toBe(200);
    expect(h.saved).toHaveLength(1);
  });

  it("removes the tenant's provider for an admin, and records it", async () => {
    const r = await DELETE(new NextRequest("https://acme.cloud.captivo.io/api/admin/sso", { method: "DELETE" }));
    expect(await r.json()).toEqual({ ok: true, removed: true });
    expect(h.audit).toEqual(["config.sso_remove"]);
  });

  it("does not let a non-admin remove it", async () => {
    h.user = { id: "u2", email: "m@acme.test", role: "member" };
    const r = await DELETE(new NextRequest("https://acme.cloud.captivo.io/api/admin/sso", { method: "DELETE" }));
    expect(r.status).toBe(403);
    expect(h.removed).toBe(0);
  });
});
