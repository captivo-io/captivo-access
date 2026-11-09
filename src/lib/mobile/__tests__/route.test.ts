import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/tenant/request", () => ({ withTenantRoute: (h: unknown) => h }));
const session = vi.fn();
vi.mock("../session", () => ({ mobileSessionFromRequest: (...a: unknown[]) => session(...a) }));
let tenant = "acme";
vi.mock("@/lib/tenant/context", () => ({ currentTenantId: () => tenant }));

import { mobileRoute } from "../route";

const handler = vi.fn(async () => new Response("ok"));
const route = mobileRoute("approve_grants", handler);
const req = () => new Request("https://acme.cloud.example/api/mobile/requests/g1/decision", { method: "POST" });

beforeEach(() => { vi.clearAllMocks(); tenant = "acme"; });

describe("mobileRoute", () => {
  it("no bearer: 401, the handler never runs", async () => {
    session.mockResolvedValue(null);
    expect((await route(req(), {})).status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });

  it("the CURRENT role decides: an auditor cannot approve", async () => {
    session.mockResolvedValue({ sessionId: "s1", user: { id: "u1", role: "AUDITOR" } });
    expect((await route(req(), {})).status).toBe(403);
  });

  it("an operator can", async () => {
    session.mockResolvedValue({ sessionId: "s1", user: { id: "u1", role: "OPERATOR" } });
    expect((await route(req(), {})).status).toBe(200);
    expect(handler).toHaveBeenCalledOnce();
  });

  it("any one of several capabilities is enough", async () => {
    session.mockResolvedValue({ sessionId: "s1", user: { id: "u1", role: "AUDITOR" } });
    expect((await mobileRoute(["read_console", "manage_tenants"], handler)(req(), {})).status).toBe(200);
  });

  it("manage_tenants counts only on the platform host", async () => {
    const platform = mobileRoute("manage_tenants", handler);
    session.mockResolvedValue({ sessionId: "s1", user: { id: "p1", role: "PLATFORM" } });
    expect((await platform(req(), {})).status).toBe(403);
    tenant = "platform";
    expect((await platform(req(), {})).status).toBe(200);
  });

  it("a workspace admin is no platform operator, even on the platform host", async () => {
    tenant = "platform";
    session.mockResolvedValue({ sessionId: "s1", user: { id: "u1", role: "ADMIN" } });
    expect((await mobileRoute("manage_tenants", handler)(req(), {})).status).toBe(403);
  });
});
