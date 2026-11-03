import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/tenant/request", () => ({ withTenantRoute: (h: unknown) => h }));
const session = vi.fn();
vi.mock("../session", () => ({ mobileSessionFromRequest: (...a: unknown[]) => session(...a) }));

import { mobileRoute } from "../route";

const handler = vi.fn(async () => new Response("ok"));
const route = mobileRoute("approve_grants", handler);
const req = () => new Request("https://acme.cloud.example/api/mobile/requests/g1/decision", { method: "POST" });

beforeEach(() => vi.clearAllMocks());

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
});
