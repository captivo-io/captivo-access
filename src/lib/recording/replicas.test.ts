import { describe, expect, it, beforeEach, vi } from "vitest";

type Rec = { id: string; tenantId: string; recordingKey: string; connectorId: string | null; startedAt: Date; lastEventAt: Date; purgePendingAt: Date | null };
type Rep = { id: string; recordingId: string; connectorId: string; tenantId: string; state: string; completedAt: Date | null; bytes: number; lastError: string | null; createdAt: Date };

const s = vi.hoisted(() => ({
  members: [] as { connectorId: string; group: { id: string; replicateSince: Date | null } }[],
  recs: [] as Rec[],
  reps: [] as Rep[],
}));

vi.mock("@/lib/db", () => {
  const groupMembers = (gid: string) => s.members.filter((m) => m.group.id === gid).map((m) => ({ connectorId: m.connectorId }));
  return {
    db: {
      connectorGroupMember: {
        findMany: async ({ where }: { where: { connectorId: string } }) =>
          s.members.filter((m) => m.connectorId === where.connectorId && m.group.replicateSince !== null).map((m) => ({ group: { replicateSince: m.group.replicateSince, members: groupMembers(m.group.id) } })),
      },
      sessionRecording: {
        findMany: async ({ where, take }: { where: { connectorId: { in: string[] }; startedAt: { gte: Date }; purgePendingAt: null; replicas: { none: { connectorId: string } } }; take: number }) =>
          s.recs
            .filter((r) => r.connectorId && where.connectorId.in.includes(r.connectorId) && r.startedAt >= where.startedAt.gte && r.purgePendingAt === null && !s.reps.some((p) => p.recordingId === r.id && p.connectorId === where.replicas.none.connectorId))
            .sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime())
            .slice(0, take)
            .map((r) => ({ id: r.id })),
        findUnique: async ({ where }: { where: { tenantId_recordingKey: { tenantId: string; recordingKey: string } } }) => {
          const r = s.recs.find((x) => x.tenantId === where.tenantId_recordingKey.tenantId && x.recordingKey === where.tenantId_recordingKey.recordingKey);
          return r ? { id: r.id } : null;
        },
      },
      recordingReplica: {
        createMany: async ({ data }: { data: { recordingId: string; connectorId: string; tenantId: string }[] }) => {
          for (const d of data) if (!s.reps.some((p) => p.recordingId === d.recordingId && p.connectorId === d.connectorId)) s.reps.push({ id: `p${s.reps.length}`, ...d, state: "PENDING", completedAt: null, bytes: 0, lastError: null, createdAt: new Date(s.reps.length) });
        },
        findMany: async ({ where }: { where: { connectorId: string } }) =>
          s.reps
            .filter((p) => p.connectorId === where.connectorId)
            .map((p) => ({ p, r: s.recs.find((x) => x.id === p.recordingId)! }))
            .filter(({ r }) => r.purgePendingAt === null && r.connectorId !== null)
            .map(({ p, r }) => ({ state: p.state, completedAt: p.completedAt, recording: { recordingKey: r.recordingKey, connectorId: r.connectorId, lastEventAt: r.lastEventAt } })),
        updateMany: async ({ where, data }: { where: { recordingId: string; connectorId: string }; data: Partial<Rep> }) => {
          const hit = s.reps.filter((p) => p.recordingId === where.recordingId && p.connectorId === where.connectorId);
          hit.forEach((p) => Object.assign(p, data));
          return { count: hit.length };
        },
      },
    },
  };
});

import { applyReplicaReports, parseReplicaReports, replicaWorkFor } from "./replicas";

const T0 = new Date("2026-11-28T10:00:00Z");
const at = (min: number) => new Date(T0.getTime() + min * 60_000);
const rec = (id: string, connectorId: string | null, startMin: number, over: Partial<Rec> = {}): Rec => ({ id, tenantId: "t1", recordingKey: `k-${id}`, connectorId, startedAt: at(startMin), lastEventAt: at(startMin + 1), purgePendingAt: null, ...over });

describe("what a connector owes a copy of", () => {
  beforeEach(() => {
    s.members = [
      { connectorId: "A", group: { id: "g1", replicateSince: at(0) } },
      { connectorId: "B", group: { id: "g1", replicateSince: at(0) } },
    ];
    s.recs = [];
    s.reps = [];
  });

  it("is nothing for a connector in no group, or in a group with replication off", async () => {
    s.recs = [rec("r1", "A", 5)];
    expect(await replicaWorkFor("Z", "t1")).toEqual([]);
    s.members.forEach((m) => (m.group.replicateSince = null));
    expect(await replicaWorkFor("B", "t1")).toEqual([]);
    expect(s.reps).toEqual([]);
  });

  it("is the recordings other members carried since replication was turned on, never older ones, own ones, or ones being erased", async () => {
    s.recs = [
      rec("old", "A", -30), // before replication was turned on: not copied
      rec("new", "A", 5),
      rec("mine", "B", 6), // B carried it itself
      rec("gone", "A", 7, { purgePendingAt: at(8) }),
      rec("stranger", "C", 9), // a connector outside the group
      rec("nocon", null, 10),
    ];
    expect(await replicaWorkFor("B", "t1")).toEqual([{ tenantId: "t1", recordingKey: "k-new", originConnectorId: "A" }]);
    // And it is remembered: asking again registers nothing twice.
    await replicaWorkFor("B", "t1");
    expect(s.reps).toHaveLength(1);
  });

  it("leaves a complete copy alone until the recording grows again", async () => {
    s.recs = [rec("r1", "A", 5)];
    await replicaWorkFor("B", "t1");
    await applyReplicaReports("B", "t1", [{ recordingKey: "k-r1", state: "COMPLETE", bytes: 10, error: "" }]);
    expect(await replicaWorkFor("B", "t1")).toEqual([]);
    // The session went on after a long pause.
    s.recs[0]!.lastEventAt = new Date(Date.now() + 60_000);
    expect(await replicaWorkFor("B", "t1")).toHaveLength(1);
  });

  it("serves a connector in two groups from the members of both", async () => {
    s.members.push({ connectorId: "B", group: { id: "g2", replicateSince: at(0) } }, { connectorId: "C", group: { id: "g2", replicateSince: at(0) } });
    s.recs = [rec("a", "A", 5), rec("c", "C", 6)];
    const work = await replicaWorkFor("B", "t1");
    expect(work.map((w) => w.originConnectorId).sort()).toEqual(["A", "C"]);
  });

  it("caps one answer", async () => {
    s.recs = Array.from({ length: 60 }, (_, i) => rec(`r${i}`, "A", 5 + i));
    expect((await replicaWorkFor("B", "t1")).length).toBe(50);
  });
});

describe("a data plane report", () => {
  beforeEach(() => {
    s.members = [{ connectorId: "A", group: { id: "g1", replicateSince: at(0) } }, { connectorId: "B", group: { id: "g1", replicateSince: at(0) } }];
    s.recs = [rec("r1", "A", 5)];
    s.reps = [];
  });

  it("is read defensively", () => {
    expect(parseReplicaReports("x")).toEqual([]);
    expect(
      parseReplicaReports([
        { recordingKey: "k", state: "COMPLETE", bytes: 5.9, error: "" },
        { recordingKey: "k2", state: "PENDING", bytes: 1 }, // not a state a data plane reports
        { recordingKey: "", state: "COPYING" },
        { recordingKey: "k3", state: "COPYING", bytes: -4, error: "Bad Error!" },
        { recordingKey: "k4", state: "COPYING", bytes: 1e12, error: "waiting_for_video" },
        null,
      ]),
    ).toEqual([
      { recordingKey: "k", state: "COMPLETE", bytes: 5, error: "" },
      { recordingKey: "k3", state: "COPYING", bytes: 0, error: "" },
      { recordingKey: "k4", state: "COPYING", bytes: 2 ** 31 - 1, error: "waiting_for_video" },
    ]);
  });

  it("moves a copy through its states and keeps the reason it stalled", async () => {
    await replicaWorkFor("B", "t1");
    expect(await applyReplicaReports("B", "t1", [{ recordingKey: "k-r1", state: "COPYING", bytes: 4, error: "copy_failed" }])).toBe(1);
    expect(s.reps[0]).toMatchObject({ state: "COPYING", bytes: 4, lastError: "copy_failed", completedAt: null });
    await applyReplicaReports("B", "t1", [{ recordingKey: "k-r1", state: "COMPLETE", bytes: 9, error: "" }]);
    expect(s.reps[0]).toMatchObject({ state: "COMPLETE", bytes: 9, lastError: null });
    expect(s.reps[0]!.completedAt).toBeInstanceOf(Date);
  });

  it("ignores recordings it does not know and copies that are not this connector's", async () => {
    await replicaWorkFor("B", "t1");
    expect(await applyReplicaReports("B", "t1", [{ recordingKey: "nope", state: "COMPLETE", bytes: 1, error: "" }])).toBe(0);
    expect(await applyReplicaReports("A", "t1", [{ recordingKey: "k-r1", state: "COMPLETE", bytes: 1, error: "" }])).toBe(0);
    expect(s.reps[0]!.state).toBe("PENDING");
  });
});
