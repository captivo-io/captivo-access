import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Erasing a recording that has copies: every holder must confirm, and the row
 * goes with the last one. An early delete would orphan the bytes on the holders
 * that have not confirmed -- nothing would be left to tell them what to erase.
 */
type Rec = { id: string; recordingKey: string; siteId: string; connectorId: string | null; purgePendingAt: Date | null; originPurgedAt: Date | null; replicas: { connectorId: string; purgedAt: Date | null }[] };
const s = vi.hoisted(() => ({ recs: [] as Rec[], sites: new Map<string, string | null>() }));

vi.mock("@/lib/db", () => ({
  db: {
    sessionRecording: {
      findMany: async () => s.recs.filter((r) => r.purgePendingAt),
      update: async ({ where, data }: { where: { id: string }; data: Partial<Rec> }) => Object.assign(s.recs.find((r) => r.id === where.id)!, data),
      deleteMany: async ({ where }: { where: { id: string } }) => {
        const i = s.recs.findIndex((r) => r.id === where.id && r.purgePendingAt);
        if (i >= 0) s.recs.splice(i, 1);
        return { count: i >= 0 ? 1 : 0 };
      },
      findUnique: async ({ where }: { where: { id: string } }) => s.recs.find((r) => r.id === where.id) ?? null,
    },
    recordingReplica: {
      updateMany: async ({ where, data }: { where: { recordingId: string; connectorId: string }; data: { purgedAt: Date } }) => {
        const r = s.recs.find((x) => x.id === where.recordingId)!;
        r.replicas.filter((c) => c.connectorId === where.connectorId && !c.purgedAt).forEach((c) => (c.purgedAt = data.purgedAt));
        return { count: 1 };
      },
    },
    site: {
      findMany: async () => [...s.sites.entries()].map(([id, connectorId]) => ({ id, connectorId })),
      findUnique: async ({ where }: { where: { id: string } }) => (s.sites.has(where.id) ? { connectorId: s.sites.get(where.id) } : null),
    },
  },
}));
vi.mock("@/lib/tenant/context", () => ({ currentTenantId: () => "t1" }));

import { confirmErasures, holdersOwing, pendingErasuresByConnector } from "../erasure";

const rec = (over: Partial<Rec> = {}): Rec => ({ id: "r1", recordingKey: "k1", siteId: "s1", connectorId: "A", purgePendingAt: new Date(), originPurgedAt: null, replicas: [{ connectorId: "B", purgedAt: null }, { connectorId: "C", purgedAt: null }], ...over });

describe("erasing a recording with copies", () => {
  beforeEach(() => {
    s.recs = [rec()];
    s.sites = new Map([["s1", "A"]]);
  });

  it("owes the erasure to the original and to every copy", async () => {
    const owed = await pendingErasuresByConnector();
    expect([...owed.entries()].sort()).toEqual([["A", ["k1"]], ["B", ["k1"]], ["C", ["k1"]]]);
    expect((await holdersOwing("r1")).sort()).toEqual(["A", "B", "C"]);
  });

  it("deletes the row only with the last confirmation, whatever the order", async () => {
    expect(await confirmErasures(["k1"], "B")).toBe(0);
    expect(await confirmErasures(["k1"], "A")).toBe(0);
    expect(s.recs).toHaveLength(1);
    expect((await holdersOwing("r1")).sort()).toEqual(["C"]);
    // A holder that confirmed is not asked again.
    expect([...(await pendingErasuresByConnector()).keys()]).toEqual(["C"]);
    expect(await confirmErasures(["k1"], "C")).toBe(1);
    expect(s.recs).toHaveLength(0);
  });

  it("a recording without copies is deleted by its connector's confirmation, as before", async () => {
    s.recs = [rec({ replicas: [] })];
    expect(await confirmErasures(["k1"], "A")).toBe(1);
  });

  it("a stranger's confirmation changes nothing, and a recording nobody asked to erase is not touched", async () => {
    expect(await confirmErasures(["k1"], "Z")).toBe(0);
    expect(s.recs[0]!.originPurgedAt).toBeNull();
    s.recs = [rec({ purgePendingAt: null })];
    expect(await confirmErasures(["k1"], "A")).toBe(0);
    expect(s.recs).toHaveLength(1);
  });

  it("an original that cannot be reached keeps the erasure pending even when every copy confirmed", async () => {
    s.recs = [rec({ connectorId: null })];
    s.sites = new Map([["s1", null]]);
    await confirmErasures(["k1"], "B");
    expect(await confirmErasures(["k1"], "C")).toBe(0);
    expect(s.recs).toHaveLength(1);
  });

  it("finds the original through the site for an older recording", async () => {
    s.recs = [rec({ connectorId: null, replicas: [] })];
    expect(await confirmErasures(["k1"], "A")).toBe(1);
  });
});
