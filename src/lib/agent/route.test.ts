import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./auth", () => ({
  authenticateAgent: vi.fn(async (h: string | null) => (h === "Bearer cat_a" ? { token: { id: "t-a", ratePerMinute: 120 }, user: { id: "u" } } : h === "Bearer cat_b" ? { token: { id: "t-b", ratePerMinute: 120 }, user: { id: "u2" } } : h === "Bearer cat_slow" ? { token: { id: "t-slow", ratePerMinute: 20 }, user: { id: "u3" } } : null)),
}));

import { agentRates } from "./tokens";
import { withAgent } from "./route";

const AGENT_RATE = agentRates(120);

const call = (h: ReturnType<typeof withAgent>, token: string | null) => h(new Request("http://x", { headers: token ? { authorization: `Bearer ${token}` } : {} }), undefined as never);

describe("agent API rate and auth", () => {
  beforeEach(() => vi.resetModules());

  it("answers 401 without a live token and never reaches the handler", async () => {
    const fn = vi.fn(async () => new Response("ok"));
    const h = withAgent(fn);
    expect((await call(h, null)).status).toBe(401);
    expect((await call(h, "cat_nope")).status).toBe(401);
    expect(fn).not.toHaveBeenCalled();
  });

  it("holds a token to its rate, and each token to its own", async () => {
    const h = withAgent(async () => new Response("ok"));
    for (let i = 0; i < AGENT_RATE.perMinute; i++) expect((await call(h, "cat_a")).status).toBe(200);
    const over = await call(h, "cat_a");
    expect(over.status).toBe(429);
    expect(over.headers.get("retry-after")).toBe("60");
    expect((await call(h, "cat_b")).status).toBe(200);
  });

  it("takes the rate from the token: a lower one is hit sooner, and a tenth of it caps what makes something", async () => {
    const h = withAgent(async () => new Response("ok"), { action: "connect" });
    expect(agentRates(20)).toEqual({ perMinute: 20, perMinuteAction: 2 });
    expect(agentRates(10)).toEqual({ perMinute: 10, perMinuteAction: 1 });
    expect((await call(h, "cat_slow")).status).toBe(200);
    expect((await call(h, "cat_slow")).status).toBe(200);
    expect((await call(h, "cat_slow")).status).toBe(429);
  });

  it("holds the calls that make something to a lower rate", async () => {
    const h = withAgent(async () => new Response("ok"), { action: "access" });
    const only = withAgent(async () => new Response("ok"));
    // cat_b has used 1 of its general calls above; the action cap is on its own key.
    for (let i = 0; i < AGENT_RATE.perMinuteAction; i++) expect((await call(h, "cat_b")).status).toBe(200);
    expect((await call(h, "cat_b")).status).toBe(429);
    expect((await call(only, "cat_b")).status).toBe(200);
  });
});
