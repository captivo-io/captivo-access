import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * A connector's recording report updates the index: a converted RDP/VNC
 * recording plays as video, and the console shows what the disk holds. Only
 * recordings this connector holds, in its own tenant, are touched.
 */
const recs: Record<string, { id: string; siteId: string; format: string }> = {
  k_guac: { id: "r1", siteId: "s_mine", format: "GUAC" },
  k_video: { id: "r2", siteId: "s_mine", format: "VIDEO" },
  k_other_site: { id: "r3", siteId: "s_other", format: "GUAC" },
};
const update = vi.fn(async (_a: unknown) => ({}));

vi.mock("@/lib/db", () => ({
  db: {
    sessionRecording: {
      findUnique: async ({ where }: { where: { tenantId_recordingKey: { tenantId: string; recordingKey: string } } }) =>
        recs[where.tenantId_recordingKey.recordingKey] ?? null,
      update: (a: unknown) => update(a),
    },
    site: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        ({ s_mine: { connectorId: "c1" }, s_other: { connectorId: "c2" } } as Record<string, { connectorId: string }>)[where.id] ?? null,
    },
  },
}));
vi.mock("@/lib/tenant/context", () => ({ currentTenantId: () => "t_1" }));
vi.mock("@/lib/tenant/internal", () => ({
  requireDataplaneSecret: (h: unknown) => h,
  withTenantFrom: () => (h: unknown) => h,
  resolveTenantByConnector: async () => "t_1",
}));

function post(items: unknown[]) {
  return new Request("http://m/api/internal/recording/report", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ connectorId: "c1", items }),
  });
}

beforeEach(() => update.mockClear());

describe("recording report", () => {
  it("marks a converted GUAC recording as video, with its duration and stored size", async () => {
    const { POST } = await import("../report/route");
    const res = await POST(post([{ tenantId: "t_1", recordingKey: "k_guac", video: true, durationMs: 731000, storedBytes: 1500000 }]) as never);
    expect(res.status).toBe(200);
    expect(update).toHaveBeenCalledWith({ where: { id: "r1" }, data: { videoReady: true, durationMs: 731000, bytes: 1500000 } });
  });

  it("never sets videoReady on a recording that is not GUAC", async () => {
    const { POST } = await import("../report/route");
    await POST(post([{ tenantId: "t_1", recordingKey: "k_video", video: true, durationMs: 9000, storedBytes: 10 }]) as never);
    expect(update).toHaveBeenCalledWith({ where: { id: "r2" }, data: { durationMs: 9000, bytes: 10 } });
  });

  it("ignores another tenant's items and recordings on another connector's site", async () => {
    const { POST } = await import("../report/route");
    const res = await POST(post([
      { tenantId: "t_2", recordingKey: "k_guac", video: true, storedBytes: 1 },
      { tenantId: "t_1", recordingKey: "k_other_site", video: true, storedBytes: 1 },
      { tenantId: "t_1", recordingKey: "missing", video: true, storedBytes: 1 },
    ]) as never);
    expect(res.status, "acknowledged, so the connector stops resending").toBe(200);
    expect(update).not.toHaveBeenCalled();
  });

  it("keeps the counters within their 32-bit columns and ignores junk", async () => {
    const { POST } = await import("../report/route");
    await POST(post([{ tenantId: "t_1", recordingKey: "k_guac", video: false, durationMs: -5, storedBytes: 9e12 }, "x", null]) as never);
    expect(update).toHaveBeenCalledWith({ where: { id: "r1" }, data: { videoReady: false, bytes: 2 ** 31 - 1 } });
  });
});
