import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const order: string[] = [];
vi.mock("@/lib/tenant/request", () => ({ withTenantRoute: (h: unknown) => h }));
vi.mock("@/lib/current-user", () => ({ getCurrentUser: async () => ({ id: "a1", email: "a@x", role: "ADMIN" }) }));
vi.mock("@/lib/audit/admin", () => ({ recordAdminAction: vi.fn() }));
vi.mock("@/lib/connector/history", () => ({ recordConnectorEvent: vi.fn() }));
vi.mock("@/lib/version", () => ({ managerVersion: () => "2.41.0" }));
vi.mock("@/lib/connector/telemetry", () => ({ getConnectorTelemetry: vi.fn() }));
vi.mock("@/lib/connector/dataplane", () => ({ kickConnector: vi.fn(async () => { order.push("kick"); }) }));
vi.mock("@/lib/connector/host-action-send", () => ({ sendHostAction: vi.fn(async () => { order.push("send"); return { ok: true }; }) }));
vi.mock("@/lib/db", () => ({
  db: { connector: { findUnique: vi.fn(), update: vi.fn(async () => { order.push("update"); return {}; }) } },
}));

import { POST } from "./route";
import { db } from "@/lib/db";
import { getConnectorTelemetry } from "@/lib/connector/telemetry";
import { sendHostAction } from "@/lib/connector/host-action-send";
import { kickConnector } from "@/lib/connector/dataplane";

const call = (b: unknown) =>
  POST(new NextRequest("http://x/api/admin/connectors/c1/host-action", { method: "POST", body: JSON.stringify(b), headers: { "content-type": "application/json" } }), { params: Promise.resolve({ id: "c1" }) });
const conn = (extra = {}) => ({ id: "c1", name: "Home Lab", status: "ONLINE", version: "2.40.0", hostAction: null, ...extra });
const live = (extra = {}) => ({
  online: true,
  telemetry: { version: "2.40.0", uptimeSec: 1, activeConnections: 2, totalConnections: 0, deniedCount: 0, bytesIn: 0, bytesOut: 0, updater: { version: "2.40.0", dockerOk: true }, ...extra },
});

describe("host actions from the console", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    order.length = 0;
    vi.mocked(db.connector.findUnique).mockResolvedValue(conn() as never);
    vi.mocked(getConnectorTelemetry).mockResolvedValue(live() as never);
  });

  it("updates to the manager's version, now or when idle", async () => {
    const res = await call({ action: "update", waitIdle: true });
    expect(res.status).toBe(200);
    const sent = vi.mocked(sendHostAction).mock.calls[0];
    expect(sent[0]).toBe("c1");
    expect(sent[1]).toMatchObject({ action: "update", version: "2.41.0", waitIdle: true });
    expect(sent[1].id).toMatch(/^act_/);
    const saved = vi.mocked(db.connector.update).mock.calls[0][0] as { data: { hostAction: { id: string; state: string } } };
    expect(saved.data.hostAction).toMatchObject({ id: sent[1].id, state: "sent", from: "2.40.0" });
  });

  it("refuses when there is nothing newer, no updater, or work under way", async () => {
    vi.mocked(getConnectorTelemetry).mockResolvedValue(live({ version: "2.41.0" }) as never);
    expect((await (await call({ action: "update" })).json()).error).toBe("up_to_date");
    vi.mocked(getConnectorTelemetry).mockResolvedValue(live({ updater: undefined }) as never);
    expect((await (await call({ action: "update" })).json()).error).toBe("no_updater");
    vi.mocked(getConnectorTelemetry).mockResolvedValue(live({ hostAction: { id: "act_x", action: "update", state: "applying" } }) as never);
    expect((await (await call({ action: "update" })).json()).error).toBe("busy");
    vi.mocked(getConnectorTelemetry).mockResolvedValue({ online: false } as never);
    expect((await (await call({ action: "update" })).json()).error).toBe("offline");
    expect(sendHostAction).not.toHaveBeenCalled();
  });

  it("removal needs the name, keeps the data by default, and revokes only after the connector took it", async () => {
    expect((await call({ action: "uninstall", confirmName: "Home" })).status).toBe(400);
    expect(sendHostAction).not.toHaveBeenCalled();

    const res = await call({ action: "uninstall", confirmName: "Home Lab" });
    expect(res.status).toBe(200);
    expect(vi.mocked(sendHostAction).mock.calls[0][1]).toMatchObject({ action: "uninstall", keepData: true });
    expect(order).toEqual(["send", "update", "kick"]);
    const saved = vi.mocked(db.connector.update).mock.calls[0][0] as { data: { status: string } };
    expect(saved.data.status).toBe("REVOKED");
  });

  it("does not revoke when the connector refused the removal", async () => {
    vi.mocked(sendHostAction).mockResolvedValueOnce({ ok: false, reason: "no_updater" });
    const res = await call({ action: "uninstall", confirmName: "Home Lab", keepData: false });
    expect(res.status).toBe(409);
    expect(db.connector.update).not.toHaveBeenCalled();
    expect(kickConnector).not.toHaveBeenCalled();
  });

  it("a held update may give way to a removal", async () => {
    vi.mocked(getConnectorTelemetry).mockResolvedValue(live({ hostAction: { id: "act_x", action: "update", state: "waiting_idle" } }) as never);
    expect((await call({ action: "uninstall", confirmName: "Home Lab", keepData: false })).status).toBe(200);
    expect(vi.mocked(sendHostAction).mock.calls[0][1]).toMatchObject({ action: "uninstall", keepData: false });
  });

  it("cancels only the held update it asked for", async () => {
    vi.mocked(db.connector.findUnique).mockResolvedValue(conn({ hostAction: { id: "act_x", action: "update", version: "2.41.0", by: "a@x", at: "t", state: "sent" } }) as never);
    vi.mocked(getConnectorTelemetry).mockResolvedValue(live({ hostAction: { id: "act_x", action: "update", state: "applying" } }) as never);
    expect((await call({ action: "cancel" })).status).toBe(409);
    vi.mocked(getConnectorTelemetry).mockResolvedValue(live({ hostAction: { id: "act_x", action: "update", state: "waiting_idle" } }) as never);
    expect((await call({ action: "cancel" })).status).toBe(200);
    expect(vi.mocked(sendHostAction).mock.calls[0][1]).toEqual({ id: "act_x", action: "cancel" });
  });

  it("a revoked connector takes nothing", async () => {
    vi.mocked(db.connector.findUnique).mockResolvedValue(conn({ status: "REVOKED" }) as never);
    expect((await call({ action: "update" })).status).toBe(409);
    expect(sendHostAction).not.toHaveBeenCalled();
  });
});
