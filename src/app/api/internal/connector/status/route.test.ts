import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/tenant/internal", () => ({
  requireDataplaneSecret: (h: unknown) => h,
  withTenantFrom: () => (h: unknown) => h,
  resolveTenantByConnector: async () => "t1",
}));
vi.mock("@/lib/tenant/context", () => ({ currentTenantId: () => "t1" }));
vi.mock("@/lib/settings/platform", () => ({ resolvedConnectorLogLevel: async () => "info", resolvedRecordingRetentionDays: async () => 0 }));
vi.mock("@/lib/recording/erasure", () => ({ pendingErasuresByConnector: async () => new Map() }));
vi.mock("@/lib/vault/store", () => ({ sealLegacyCredentials: vi.fn() }));
vi.mock("@/lib/connector/history", () => ({ recordConnectorEvent: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { connector: { findUnique: vi.fn(), updateMany: vi.fn() } } }));

import { POST } from "./route";
import { db } from "@/lib/db";
import { recordConnectorEvent } from "@/lib/connector/history";

const report = (b: Record<string, unknown>) =>
  POST(new NextRequest("http://x/api/internal/connector/status", { method: "POST", body: JSON.stringify({ connectorId: "c1", ...b }), headers: { "content-type": "application/json", "x-dataplane-secret": "s" } }));

describe("connector status reports", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.DATAPLANE_SECRET = "s";
  });

  it("a dropped tunnel (no version) keeps the stored version and notes no update", async () => {
    vi.mocked(db.connector.findUnique).mockResolvedValue({ status: "ONLINE", version: "2.35.1" } as never);
    await report({ status: "OFFLINE", version: "" });
    const data = (vi.mocked(db.connector.updateMany).mock.calls[0][0] as { data: Record<string, unknown> }).data;
    expect(data).not.toHaveProperty("version");
    expect(vi.mocked(recordConnectorEvent).mock.calls.map((c) => c[2])).toEqual(["Tunnel dropped"]);
  });

  it("the reconnect with a new version notes the update", async () => {
    vi.mocked(db.connector.findUnique).mockResolvedValue({ status: "OFFLINE", version: "2.35.1" } as never);
    await report({ status: "ONLINE", version: "2.41.0" });
    const data = (vi.mocked(db.connector.updateMany).mock.calls[0][0] as { data: Record<string, unknown> }).data;
    expect(data.version).toBe("2.41.0");
    expect(vi.mocked(recordConnectorEvent).mock.calls.map((c) => c[2])).toEqual(["Tunnel opened", "Updated 2.35.1 → 2.41.0"]);
  });

  const CA = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJ9bX0m1cV7eT0b1Yk2pQ0o5a3o0sY0xv7oQe3Xc2kqL";

  it("keeps the connector's SSH certificate authority, one clean ed25519 line only", async () => {
    vi.mocked(db.connector.findUnique).mockResolvedValue({ status: "ONLINE", version: "2.69.0" } as never);
    await report({ status: "ONLINE", version: "2.69.0", sshCaPublicKey: CA });
    expect((vi.mocked(db.connector.updateMany).mock.calls[0][0] as { data: Record<string, unknown> }).data.sshCaPublicKey).toBe(CA);
    for (const bad of [CA + " ana@acme", CA + "\nssh-rsa AAAA", "ssh-rsa AAAA", "", 7]) {
      vi.mocked(db.connector.updateMany).mockClear();
      await report({ status: "ONLINE", version: "2.69.0", sshCaPublicKey: bad });
      expect((vi.mocked(db.connector.updateMany).mock.calls[0][0] as { data: Record<string, unknown> }).data).not.toHaveProperty("sshCaPublicKey");
    }
  });
});
