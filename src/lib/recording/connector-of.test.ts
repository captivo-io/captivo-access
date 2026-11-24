import { describe, expect, it, vi, beforeEach } from "vitest";

const state = vi.hoisted(() => ({
  site: null as { connectorId: string } | null,
  connectors: [{ id: "c-home" }, { id: "c-lab" }],
  holds: new Set<string>(),
  updated: [] as { id: string; connectorId: string }[],
  asked: [] as string[],
}));

vi.mock("@/lib/db", () => ({
  db: {
    site: { findUnique: async () => state.site },
    connector: { findMany: async () => state.connectors },
    sessionRecording: { update: async ({ where, data }: { where: { id: string }; data: { connectorId: string } }) => { state.updated.push({ id: where.id, connectorId: data.connectorId }); } },
  },
}));
vi.mock("@/lib/tenant/context", () => ({ currentTenantId: () => "t1" }));
vi.mock("@/lib/dataplane/recordings", () => ({
  fetchFromConnector: async (i: { connectorId: string; format: string }) => {
    state.asked.push(`${i.connectorId}:${i.format}`);
    return state.holds.has(`${i.connectorId}:${i.format}`) ? { body: new ReadableStream(), totalBytes: 1 } : null;
  },
}));

import { connectorForRecording } from "./connector-of";

describe("connectorForRecording", () => {
  beforeEach(() => {
    state.site = null;
    state.holds.clear();
    state.updated = [];
    state.asked = [];
  });

  it("uses the recording's own connector, then its resource's", async () => {
    expect(await connectorForRecording({ siteId: "s", connectorId: "c-own" })).toBe("c-own");
    state.site = { connectorId: "c-site" };
    expect(await connectorForRecording({ siteId: "s" })).toBe("c-site");
    expect(state.asked).toEqual([]);
  });

  it("finds the connector holding an older recording of a deleted resource, and keeps it", async () => {
    state.holds.add("c-lab:guac");
    expect(await connectorForRecording({ id: "r1", siteId: "gone", recordingKey: "k", format: "GUAC" })).toBe("c-lab");
    expect(state.updated).toEqual([{ id: "r1", connectorId: "c-lab" }]);
    state.holds.clear();
    state.holds.add("c-home:video");
    expect(await connectorForRecording({ id: "r2", siteId: "gone", recordingKey: "k2", format: "RDP" })).toBe("c-home");
  });

  it("answers null when no connector holds it, or when it can't ask", async () => {
    expect(await connectorForRecording({ id: "r1", siteId: "gone", recordingKey: "k", format: "TERM" })).toBeNull();
    expect(state.updated).toEqual([]);
    expect(await connectorForRecording({ siteId: "gone" })).toBeNull();
  });
});
