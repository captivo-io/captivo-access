import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The control plane keeps the recording INDEX and never the bytes.
 *
 * After connector-local recordings the dataplane writes chunks into the customer's
 * connector and reports only {recordingKey, seq, bytes} here. These tests pin both
 * halves of that: the index row is still maintained, and recordingChunk.create is
 * never called -- a negative assertion, because a stray chunk write would recreate
 * the central copy this whole change exists to remove, silently and correctly-looking.
 */
const chunkCreate = vi.fn();
const upsert = vi.fn(async (_args?: unknown) => ({ id: "rec_1" }));
const findFirst = vi.fn(async () => null);

vi.mock("@/lib/db", () => ({
  db: {
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        sessionRecording: { upsert, findFirst, update: vi.fn() },
        recordingChunk: { create: chunkCreate, deleteMany: vi.fn() },
      }),
  },
}));
vi.mock("@/lib/tenant/context", () => ({ currentTenantId: () => "t_1" }));
vi.mock("@/lib/tenant/internal", () => ({
  requireDataplaneSecret: (h: unknown) => h,
  withTenantFrom: () => (h: unknown) => h,
  resolveTenantBySite: async () => "t_1",
}));
vi.mock("@/lib/recording/enabled", () => ({ recordingEnabled: () => true }));

function reqWith(body: unknown) {
  return new Request("http://m/api/internal/recording/ingest", {
    method: "POST",
    headers: { "content-type": "application/json", "x-dataplane-secret": "s" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  chunkCreate.mockClear();
  upsert.mockClear();
  process.env.DATAPLANE_SECRET = "s";
});

describe("recording ingest", () => {
  it("keeps the index row from an index-only body", async () => {
    const { POST } = await import("../ingest/route");
    const res = await POST(reqWith({ recordingKey: "k1", seq: 3, bytes: 128, userId: "u", siteId: "s", host: "h" }) as never);
    expect(res.status).toBe(204);
    expect(upsert, "the index row must still be maintained").toHaveBeenCalled();
  });

  it("NEVER writes recording bytes centrally", async () => {
    const { POST } = await import("../ingest/route");
    await POST(reqWith({ recordingKey: "k1", seq: 0, bytes: 64, siteId: "s" }) as never);
    expect(chunkCreate, "a chunk reached the control-plane database").not.toHaveBeenCalled();
  });

  it("reports the byte count the connector was asked to store", async () => {
    const { POST } = await import("../ingest/route");
    await POST(reqWith({ recordingKey: "k1", seq: 0, bytes: 4096, siteId: "s" }) as never);
    const arg = upsert.mock.calls[0]?.[0] as unknown as { create: { bytes: number } };
    expect(arg.create.bytes).toBe(4096);
  });

  it("ignores a body with no recording key", async () => {
    const { POST } = await import("../ingest/route");
    const res = await POST(reqWith({ seq: 0, bytes: 10 }) as never);
    expect(res.status).toBe(204);
    expect(upsert).not.toHaveBeenCalled();
  });
});
