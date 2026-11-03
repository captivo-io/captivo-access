import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const findMany = vi.fn();
const deleteMany = vi.fn();
vi.mock("@/lib/db", () => ({ db: { mobileDevice: { findMany: (...a: unknown[]) => findMany(...a), deleteMany: (...a: unknown[]) => deleteMany(...a) } } }));

import { isExpoToken, pushToCapability } from "../push";

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
});
