import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// An admin closing their own workspace. The gate (close-gate.ts) is real here;
// only the request's surroundings are faked: who is signed in, with which
// cookies, how old the session row is, and whether this is Cloud.
const state = vi.hoisted(() => ({
  user: { id: "u1", email: "admin@acme.example", role: "ADMIN" } as { id: string; email: string; role: string } | null,
  cookies: { ca_session: "tok" } as Record<string, string>,
  sessionAgeMs: 60_000,
  multiTenant: true,
  tenantId: "t_acme",
}));

vi.mock("@/lib/tenant/request", () => ({ withTenantRoute: (h: unknown) => h }));
vi.mock("@/lib/tenant/scope", () => ({ withTenant: (_t: string, fn: () => Promise<unknown>) => fn(), SLOW_SCOPE_BUDGET_MS: 30_000 }));
vi.mock("@/lib/tenant/enabled", () => ({ multiTenantEnabled: () => state.multiTenant }));
vi.mock("@/lib/tenant/context", () => ({ currentTenantId: () => state.tenantId }));
vi.mock("@/lib/current-user", () => ({ getCurrentUser: async () => state.user }));
vi.mock("@/lib/mobile/views", () => ({ workspaceView: async () => ({ name: "Acme", slug: "acme", origin: "https://acme.cloud.example" }) }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (n: string) => (state.cookies[n] ? { value: state.cookies[n] } : undefined) }),
}));
vi.mock("@/lib/db", () => ({
  db: {
    session: { findFirst: async () => ({ createdAt: new Date(Date.now() - state.sessionAgeMs) }) },
    $executeRawUnsafe: vi.fn(async () => 1),
  },
}));
vi.mock("@/lib/support/session", () => ({ SUPPORT_COOKIE: "ca_support", SUPPORT_USER_EMAIL: "platform-support@captivo.local" }));
vi.mock("@/lib/platform/tenants", () => ({ PURGE_AFTER_DAYS: 30 }));
vi.mock("@/lib/audit/admin", () => ({ recordAdminAction: vi.fn(async () => {}) }));
vi.mock("@/lib/email/mailer", () => ({
  getAdminEmails: async () => ["admin@acme.example", "other@acme.example", "platform-support@captivo.local"],
  sendMail: vi.fn(async () => ({ sent: true })),
}));

import { POST } from "./route";
import { db } from "@/lib/db";
import { recordAdminAction } from "@/lib/audit/admin";
import { sendMail } from "@/lib/email/mailer";

const call = (b: Record<string, unknown> = { confirmSlug: "acme" }) =>
  POST(new NextRequest("http://acme.x/api/admin/workspace/close", { method: "POST", body: JSON.stringify(b), headers: { "content-type": "application/json" } }));

describe("closing a workspace from inside it", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.user = { id: "u1", email: "admin@acme.example", role: "ADMIN" };
    state.cookies = { ca_session: "tok" };
    state.sessionAgeMs = 60_000;
    state.multiTenant = true;
    state.tenantId = "t_acme";
  });

  it("records both audit entries, closes the tenant in scope and mails the admins", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(new Date(body.restorableUntil).getTime() - Date.now()).toBeGreaterThan(29 * 86_400_000);
    const actions = vi.mocked(recordAdminAction).mock.calls.map((c) => c[0].action);
    // Platform first: the in-scope append holds the chain lock until the request commits.
    expect(actions).toEqual(["platform.tenant.self_close", "workspace.close"]);
    expect(db.$executeRawUnsafe).toHaveBeenCalledWith(expect.stringContaining("platform_delete_tenant"), "t_acme");
    const mail = vi.mocked(sendMail).mock.calls[0][0];
    expect(mail.to).toEqual(["admin@acme.example", "other@acme.example"]);
    expect(mail.subject).toBe("Workspace closed: Acme");
  });

  it("is for admins only", async () => {
    state.user = { id: "u2", email: "op@acme.example", role: "OPERATOR" };
    expect((await call()).status).toBe(403);
    expect(db.$executeRawUnsafe).not.toHaveBeenCalled();
  });

  it("asks for a fresh sign-in when the session is older than ten minutes", async () => {
    state.sessionAgeMs = 11 * 60_000;
    const res = await call();
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("reauth_required");
    expect(db.$executeRawUnsafe).not.toHaveBeenCalled();
  });

  it("needs the workspace address typed exactly", async () => {
    const res = await call({ confirmSlug: "acme-typo" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("confirm_mismatch");
    expect((await call({})).status).toBe(400);
    expect(db.$executeRawUnsafe).not.toHaveBeenCalled();
  });

  it("refuses a Captivo support session", async () => {
    state.cookies = { ca_support: "sup", ca_session: "tok" };
    const res = await call();
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("support_session");
    state.cookies = { ca_session: "tok" };
    state.user = { id: "s1", email: "platform-support@captivo.local", role: "ADMIN" };
    expect((await call()).status).toBe(403);
    expect(db.$executeRawUnsafe).not.toHaveBeenCalled();
  });

  it("does not exist on self-host", async () => {
    state.multiTenant = false;
    expect((await call()).status).toBe(404);
    state.multiTenant = true;
    state.tenantId = "default";
    expect((await call()).status).toBe(404);
    expect(db.$executeRawUnsafe).not.toHaveBeenCalled();
  });

  it("refuses an anonymous caller", async () => {
    state.user = null;
    expect((await call()).status).toBe(401);
  });
});
