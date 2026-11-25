import { NextResponse } from "next/server";
import { checkRateLimit } from "@/lib/rate-limit";
import { authenticateAgent, type AgentAuth } from "./auth";
import { agentRates } from "./tokens";

/** The 401 an agent gets: nothing says whether the token never existed, ran out or was revoked. */
export const agentUnauthorized = () => NextResponse.json({ error: "unauthorized" }, { status: 401, headers: { "www-authenticate": "Bearer" } });


const rateLimited = () => NextResponse.json({ error: "rate_limited", message: "Too many requests; wait a minute." }, { status: 429, headers: { "retry-after": "60" } });

/**
 * Wraps an /api/agent/v1 handler so it runs only for a live agent token that
 * is within its rate. `action` marks a call that makes something (access
 * request, connection), held to a lower rate of its own. Use inside
 * withTenantRoute.
 */
export function withAgent<Ctx = unknown>(handler: (req: Request, agent: AgentAuth, ctx: Ctx) => Promise<Response>, opts: { action?: string } = {}) {
  return async (req: Request, ctx: Ctx): Promise<Response> => {
    const agent = await authenticateAgent(req.headers.get("authorization"));
    if (!agent) return agentUnauthorized();
    // What the token allows per minute: all calls together, and a tenth for the ones that make something (a request, a connection).
    const rate = agentRates(agent.token.ratePerMinute);
    if (!checkRateLimit(`agent:${agent.token.id}`, rate.perMinute, 60_000)) return rateLimited();
    if (opts.action && !checkRateLimit(`agent:${agent.token.id}:${opts.action}`, rate.perMinuteAction, 60_000)) return rateLimited();
    const res = await handler(req, agent, ctx);
    res.headers.set("cache-control", "no-store");
    return res;
  };
}
