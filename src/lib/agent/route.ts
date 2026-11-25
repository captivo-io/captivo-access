import { NextResponse } from "next/server";
import { authenticateAgent, type AgentAuth } from "./auth";

/** The 401 an agent gets: nothing says whether the token never existed, ran out or was revoked. */
export const agentUnauthorized = () => NextResponse.json({ error: "unauthorized" }, { status: 401, headers: { "www-authenticate": "Bearer" } });

/** Wraps an /api/agent/v1 handler so it runs only for a live agent token. Use inside withTenantRoute. */
export function withAgent<Ctx = unknown>(handler: (req: Request, agent: AgentAuth, ctx: Ctx) => Promise<Response>) {
  return async (req: Request, ctx: Ctx): Promise<Response> => {
    const agent = await authenticateAgent(req.headers.get("authorization"));
    if (!agent) return agentUnauthorized();
    const res = await handler(req, agent, ctx);
    res.headers.set("cache-control", "no-store");
    return res;
  };
}
