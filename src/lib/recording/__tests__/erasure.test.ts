import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Erasure is a request, not an act: the bytes live on the customer's connector.
 *
 * The property these tests exist for is the uncomfortable one -- while a connector is
 * offline an accepted erasure has NOT happened, and the system must keep saying so.
 * Reporting it done would be a false compliance claim.
 */
const update = vi.fn(async (_a?: unknown) => ({}));
const deleteMany = vi.fn(async (_a?: unknown) => ({ count: 1 }));
const findManyRec = vi.fn();
const findUnique = vi.fn(async () => ({ id: "r1" }));
const findManySite = vi.fn();

vi.mock("@/lib/db", () => ({
  db: {
    sessionRecording: { update, deleteMany, findMany: findManyRec, findUnique },
    site: { findMany: findManySite },
  },
}));
vi.mock("@/lib/tenant/context", () => ({ currentTenantId: () => "t1" }));

beforeEach(() => {
  update.mockClear();
  deleteMany.mockClear();
  findManyRec.mockReset();
  findManySite.mockReset();
});

describe("recording erasure", () => {
  it("marks a recording pending rather than deleting the row", async () => {
    const { requestErasure } = await import("../erasure");
    expect(await requestErasure("r1")).toBe(true);
    // Deleting the row here would orphan the bytes on the connector forever: nothing
    // would be left to tell the connector which recording to erase.
    expect(deleteMany).not.toHaveBeenCalled();
    const arg = update.mock.calls[0]?.[0] as unknown as { data: { purgePendingAt: Date } };
    expect(arg.data.purgePendingAt).toBeInstanceOf(Date);
  });

  it("groups pending erasures by connector", async () => {
    findManyRec.mockResolvedValue([
      { recordingKey: "a", siteId: "s1" },
      { recordingKey: "b", siteId: "s1" },
      { recordingKey: "c", siteId: "s2" },
    ]);
    findManySite.mockResolvedValue([
      { id: "s1", connectorId: "c1" },
      { id: "s2", connectorId: "c2" },
    ]);
    const { pendingErasuresByConnector } = await import("../erasure");
    const got = await pendingErasuresByConnector();
    expect(got.get("c1")?.sort()).toEqual(["a", "b"]);
    expect(got.get("c2")).toEqual(["c"]);
  });

  it("keeps a recording pending when its connector is gone", async () => {
    findManyRec.mockResolvedValue([{ recordingKey: "a", siteId: "s1" }]);
    findManySite.mockResolvedValue([{ id: "s1", connectorId: null }]);
    const { pendingErasuresByConnector } = await import("../erasure");
    const got = await pendingErasuresByConnector();
    // Not silently dropped: dropping it would report an erasure nobody performed.
    expect(got.size).toBe(0);
  });

  it("only deletes rows that were actually pending on confirmation", async () => {
    const { confirmErasures } = await import("../erasure");
    await confirmErasures(["a"]);
    const arg = deleteMany.mock.calls[0]?.[0] as unknown as {
      where: { purgePendingAt: unknown; tenantId: string };
    };
    // A confirmation for something nobody asked to erase must not delete an
    // administrator's recording.
    expect(arg.where.purgePendingAt).toEqual({ not: null });
    expect(arg.where.tenantId).toBe("t1");
  });

  it("confirms nothing for an empty list", async () => {
    const { confirmErasures } = await import("../erasure");
    expect(await confirmErasures([])).toBe(0);
    expect(deleteMany).not.toHaveBeenCalled();
  });

  it("does not trim the index when retention is unset", async () => {
    const { trimIndexAfterRetention } = await import("../erasure");
    expect(await trimIndexAfterRetention(0)).toBe(0);
    expect(deleteMany, "zero retention must never delete").not.toHaveBeenCalled();
  });
});
