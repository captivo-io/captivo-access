// A small Model Context Protocol server over the agent API: the same four
// operations as /api/agent/v1, as tools an MCP client (an AI agent's host) can
// call. Streamable HTTP, stateless: one JSON-RPC message in, one answer out.

export const MCP_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;

type Json = Record<string, unknown>;
type Rpc = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Json };
export type RpcAnswer = { jsonrpc: "2.0"; id: string | number | null; result?: unknown; error?: { code: number; message: string } };

export const MCP_TOOLS = [
  {
    name: "list_resources",
    description: "List the resources this agent may ask for, and where each stands (no access, pending, active with its end time).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "request_access",
    description: "Ask for time-boxed access to one resource, with the reason. A person usually approves it; check with access_status. Access ends by itself.",
    inputSchema: {
      type: "object",
      properties: {
        siteId: { type: "string", description: "The resource's id, from list_resources." },
        minutes: { type: "integer", minimum: 5, description: "How long, in minutes. Held to this token's limit." },
        reason: { type: "string", minLength: 10, description: "Why the access is needed; it goes to the approver and the audit log." },
        ticket: { type: "string", description: "A change or incident number, when the resource asks for one." },
      },
      required: ["siteId", "reason"],
      additionalProperties: false,
    },
  },
  {
    name: "access_status",
    description: "Where a request stands: pending, active, denied, revoked or expired.",
    inputSchema: { type: "object", properties: { id: { type: "string", description: "The id request_access returned." } }, required: ["id"], additionalProperties: false },
  },
  {
    name: "connect",
    description: "Once access is active: how to connect to the resource (an SSH command, a database client command and ticket, or a kubeconfig). The ticket is short-lived; no password is involved.",
    inputSchema: { type: "object", properties: { siteId: { type: "string", description: "The resource's id." } }, required: ["siteId"], additionalProperties: false },
  },
] as const;

/** Runs one tool; the route supplies it (the agent API's own handlers). */
export type ToolCall = (name: string, args: Json) => Promise<{ ok: boolean; body: unknown } | null>;

const err = (id: Rpc["id"], code: number, message: string): RpcAnswer => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

/** Answers one JSON-RPC message; null for a notification (nothing to send back). */
export async function handleRpc(msg: unknown, call: ToolCall, serverVersion: string): Promise<RpcAnswer | null> {
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) return err(null, -32600, "Invalid request");
  const m = msg as Rpc;
  if (m.jsonrpc !== "2.0" || typeof m.method !== "string") return err(m.id, -32600, "Invalid request");
  if (m.id === undefined) return null; // notifications/initialized and the like
  const id = m.id;
  switch (m.method) {
    case "initialize": {
      const asked = typeof m.params?.protocolVersion === "string" ? m.params.protocolVersion : "";
      const version = (MCP_VERSIONS as readonly string[]).includes(asked) ? asked : MCP_VERSIONS[0];
      return { jsonrpc: "2.0", id, result: { protocolVersion: version, capabilities: { tools: {} }, serverInfo: { name: "captivo-access", version: serverVersion }, instructions: "Ask for access to a resource with request_access, wait until access_status says active, then connect." } };
    }
    case "ping":
      return { jsonrpc: "2.0", id, result: {} };
    case "tools/list":
      return { jsonrpc: "2.0", id, result: { tools: MCP_TOOLS } };
    case "tools/call": {
      const name = typeof m.params?.name === "string" ? m.params.name : "";
      if (!MCP_TOOLS.some((t) => t.name === name)) return err(id, -32602, `Unknown tool: ${name}`);
      const args = m.params?.arguments && typeof m.params.arguments === "object" && !Array.isArray(m.params.arguments) ? (m.params.arguments as Json) : {};
      const r = await call(name, args);
      if (!r) return err(id, -32001, "Unauthorized");
      return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(r.body, null, 2) }], isError: !r.ok } };
    }
    default:
      return err(id, -32601, `Method not found: ${m.method}`);
  }
}
