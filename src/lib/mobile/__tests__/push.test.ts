import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const findMany = vi.fn();
const deleteMany = vi.fn();
vi.mock("@/lib/db", () => ({ db: { mobileDevice: { findMany: (...a: unknown[]) => findMany(...a), deleteMany: (...a: unknown[]) => deleteMany(...a) } } }));

vi.mock("@/lib/tenant/enabled", () => ({ multiTenantEnabled: () => true }));
const scopes: string[] = [];
vi.mock("@/lib/tenant/scope", () => ({ withTenant: (id: string, fn: () => unknown) => { scopes.push(id); return fn(); } }));

import { isExpoToken, pushToCapability, pushToPlatform } from "../push";

const fetchMock = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", fetchMock);
  findMany.mockResolvedValue([
    { expoPushToken: "ExponentPushToken[admin]", user: { role: "ADMIN" } },
    { expoPushToken: "ExponentPushToken[auditor]", user: { role: "AUDITOR" } },
    { expoPushToken: "ExponentPushToken[gone]", user: { role: "OPERATOR" } },
  ]);
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ data: [{ status: "ok" }, { status: "error", details: { error: "DeviceNotRegistered" } }] })));
});
afterEach(() => vi.unstubAllGlobals());

describe("app push", () => {
  it("recognises only Expo tokens", () => {
    expect(isExpoToken("ExponentPushToken[abc]")).toBe(true);
    expect(isExpoToken("ExpoPushToken[abc]")).toBe(true);
    expect(isExpoToken("https://evil.example")).toBe(false);
  });

  it("reaches only people whose role holds the capability, and drops dead tokens", async () => {
    await pushToCapability("approve_grants", { title: "t", body: "b", data: { type: "access_request" } });
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body as string).map((m: { to: string }) => m.to);
    expect(sent).toEqual(["ExponentPushToken[admin]", "ExponentPushToken[gone]"]);
    expect(deleteMany).toHaveBeenCalledWith({ where: { expoPushToken: { in: ["ExponentPushToken[gone]"] } } });
  });

  it("never throws, even when Expo is unreachable", async () => {
    fetchMock.mockRejectedValue(new Error("down"));
    await expect(pushToCapability("read_console", { title: "t", body: "b", data: {} })).resolves.toBeUndefined();
  });

  it("passes a notification category through, so the app can show buttons", async () => {
    await pushToCapability("approve_grants", { title: "t", body: "b", data: {}, categoryId: "access_request" });
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(sent[0].categoryId).toBe("access_request");
  });

  it("platform pushes read the platform tenant's operators only", async () => {
    scopes.length = 0;
    findMany.mockResolvedValue([
      { expoPushToken: "ExponentPushToken[op]", user: { role: "PLATFORM" } },
      { expoPushToken: "ExponentPushToken[adm]", user: { role: "ADMIN" } },
    ]);
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ data: [{ status: "ok" }] })));
    await pushToPlatform({ title: "New workspace", body: "x", data: { type: "platform_tenant" } });
    expect(scopes).toEqual(["platform"]);
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(sent.map((m: { to: string }) => m.to)).toEqual(["ExponentPushToken[op]"]);
  });
});
