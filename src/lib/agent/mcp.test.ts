import { describe, it, expect, vi } from "vitest";
import { handleRpc, MCP_TOOLS, MCP_VERSIONS } from "@/lib/agent/mcp";

const none = vi.fn(async () => ({ ok: true, body: { fine: true } }));

describe("MCP over the agent API", () => {
  it("initializes with the client's protocol version when it is one it knows", async () => {
    const a = await handleRpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } }, none, "2.74.0");
    expect(a).toMatchObject({ id: 1, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "captivo-access", version: "2.74.0" } } });
    const b = await handleRpc({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1999-01-01" } }, none, "x");
    expect((b!.result as { protocolVersion: string }).protocolVersion).toBe(MCP_VERSIONS[0]);
  });

  it("sends nothing back for a notification, and answers ping and the tool list", async () => {
    expect(await handleRpc({ jsonrpc: "2.0", method: "notifications/initialized" }, none, "x")).toBeNull();
    expect((await handleRpc({ jsonrpc: "2.0", id: 3, method: "ping" }, none, "x"))!.result).toEqual({});
    const l = await handleRpc({ jsonrpc: "2.0", id: 4, method: "tools/list" }, none, "x");
    expect((l!.result as { tools: { name: string }[] }).tools.map((t) => t.name)).toEqual(["list_resources", "request_access", "access_status", "connect"]);
    expect(MCP_TOOLS.every((t) => t.inputSchema.type === "object" && t.description.length > 20)).toBe(true);
  });

  it("runs a tool and reports a failure as a tool error, not a protocol one", async () => {
    const call = vi.fn(async (name: string) => (name === "connect" ? { ok: false, body: { error: "no_active_access" } } : { ok: true, body: { id: "g1" } }));
    const ok = await handleRpc({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "request_access", arguments: { siteId: "s", reason: "Roll back release 4.2" } } }, call, "x");
    expect(call).toHaveBeenCalledWith("request_access", { siteId: "s", reason: "Roll back release 4.2" });
    expect(ok!.result).toMatchObject({ isError: false, content: [{ type: "text" }] });
    const bad = await handleRpc({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "connect", arguments: { siteId: "s" } } }, call, "x");
    expect(bad!.result).toMatchObject({ isError: true });
    expect(JSON.stringify(bad!.result)).toContain("no_active_access");
  });

  it("refuses what it does not know or cannot authenticate", async () => {
    expect((await handleRpc({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "rm_rf" } }, none, "x"))!.error?.code).toBe(-32602);
    expect((await handleRpc({ jsonrpc: "2.0", id: 8, method: "resources/list" }, none, "x"))!.error?.code).toBe(-32601);
    expect((await handleRpc({ id: 9, method: "ping" }, none, "x"))!.error?.code).toBe(-32600);
    expect((await handleRpc("nope", none, "x"))!.error?.code).toBe(-32600);
    const unauth = await handleRpc({ jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "list_resources" } }, async () => null, "x");
    expect(unauth!.error?.code).toBe(-32001);
  });
});
