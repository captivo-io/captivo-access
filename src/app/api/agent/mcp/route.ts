import { NextResponse } from "next/server";
import { managerVersion } from "@/lib/version";
import { agentUnauthorized } from "@/lib/agent/route";
import { handleRpc, type ToolCall } from "@/lib/agent/mcp";
import * as me from "@/app/api/agent/v1/me/route";
import * as access from "@/app/api/agent/v1/access/route";
import * as accessId from "@/app/api/agent/v1/access/[id]/route";
import * as connect from "@/app/api/agent/v1/connect/[siteId]/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The agent API as an MCP server (lib/agent/mcp.ts): POST JSON-RPC with the
// agent token as the bearer. Each tool runs the same handler the REST call
// does, with the same checks, rate and audit, so nothing here is a second way
// in. Not wrapped in a tenant scope itself: each handler opens its own.

type Handler = (req: Request, ctx: never) => Promise<Response>;

export async function POST(req: Request): Promise<Response> {
  const auth = req.headers.get("authorization");
  if (!auth) return agentUnauthorized();
  const origin = new URL(req.url).origin;
  const rest = (path: string, method: string, body?: unknown) =>
    new Request(`${origin}/api/agent/v1/${path}`, { method, headers: { authorization: auth, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const run = async (h: Handler, r: Request, ctx?: unknown) => {
    const res = await h(r, ctx as never);
    if (res.status === 401) return null;
    return { ok: res.ok, body: await res.json().catch(() => ({})) as unknown };
  };
  const call: ToolCall = async (name, a) => {
    const str = (k: string) => (typeof a[k] === "string" ? (a[k] as string) : "");
    switch (name) {
      case "list_resources": return run(me.GET as unknown as Handler, rest("me", "GET"));
      case "request_access": return run(access.POST as unknown as Handler, rest("access", "POST", { siteId: str("siteId"), reason: str("reason"), ...(a.minutes !== undefined ? { minutes: a.minutes } : {}), ...(str("ticket") ? { ticket: str("ticket") } : {}) }));
      case "access_status": return run(accessId.GET as unknown as Handler, rest(`access/${encodeURIComponent(str("id"))}`, "GET"), { params: Promise.resolve({ id: str("id") }) });
      case "connect": return run(connect.POST as unknown as Handler, rest(`connect/${encodeURIComponent(str("siteId"))}`, "POST"), { params: Promise.resolve({ siteId: str("siteId") }) });
    }
    return null;
  };

  const body = await req.json().catch(() => undefined);
  const messages = Array.isArray(body) ? body : [body];
  const answers = [];
  for (const m of messages) {
    // A bad token is a 401 for the whole call, so a misconfigured client sees it at "initialize".
    const probe = m && typeof m === "object" && ((m as { method?: string }).method === "initialize" || (m as { method?: string }).method === "tools/list");
    if (probe && !(await run(me.GET as unknown as Handler, rest("me", "GET")))) return agentUnauthorized();
    const a = await handleRpc(m, call, managerVersion());
    if (a) answers.push(a);
  }
  if (answers.length === 0) return new Response(null, { status: 202 });
  return NextResponse.json(Array.isArray(body) ? answers : answers[0], { headers: { "cache-control": "no-store" } });
}

// No server-initiated stream: a client that asks for one is told so.
export async function GET(): Promise<Response> {
  return new Response("This MCP server answers POST only.", { status: 405, headers: { allow: "POST" } });
}
