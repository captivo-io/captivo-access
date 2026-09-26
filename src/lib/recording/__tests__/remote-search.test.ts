import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Command search runs on the connectors that hold the text.
 *
 * Since keystroke events moved to the connector store, the control plane can no
 * longer scan them: it asks each connector that owns candidate recordings and
 * merges the answers. The property that matters most is the PARTIAL one -- an
 * offline connector must make the result say so, because "no matches" and "we
 * could not look" mean opposite things to an administrator investigating an
 * incident.
 */
const searchOnConnector = vi.fn();
vi.mock("@/lib/dataplane/recordings", () => ({ searchOnConnector }));

beforeEach(() => searchOnConnector.mockReset());

async function subject() {
  return (await import("../remote-search")).searchRecordingsOnConnectors;
}

describe("searchRecordingsOnConnectors", () => {
  it("merges matches from several connectors", async () => {
    searchOnConnector
      .mockResolvedValueOnce({ ok: true, matches: [{ recordingKey: "a", seq: 0, snippet: "rm" }], truncated: false })
      .mockResolvedValueOnce({ ok: true, matches: [{ recordingKey: "b", seq: 1, snippet: "rm" }], truncated: false });

    const run = await subject();
    const res = await run({
      tenantId: "t1",
      query: "rm",
      candidates: [
        { recordingKey: "a", connectorId: "c1" },
        { recordingKey: "b", connectorId: "c2" },
      ],
    });
    expect(res.matchedKeys.sort()).toEqual(["a", "b"]);
    expect(res.partial).toBe(false);
  });

  it("reports a PARTIAL result when a connector is offline", async () => {
    searchOnConnector
      .mockResolvedValueOnce({ ok: true, matches: [{ recordingKey: "a", seq: 0, snippet: "rm" }], truncated: false })
      .mockResolvedValueOnce({ ok: false, error: "connector offline" });

    const run = await subject();
    const res = await run({
      tenantId: "t1",
      query: "rm",
      candidates: [
        { recordingKey: "a", connectorId: "c1" },
        { recordingKey: "b", connectorId: "c2" },
      ],
    });
    expect(res.matchedKeys).toEqual(["a"]);
    expect(res.partial, "an offline connector must make the answer partial").toBe(true);
    expect(res.unreachableConnectors).toEqual(["c2"]);
  });

  it("groups candidates so each connector is asked once", async () => {
    searchOnConnector.mockResolvedValue({ ok: true, matches: [], truncated: false });
    const run = await subject();
    await run({
      tenantId: "t1",
      query: "rm",
      candidates: [
        { recordingKey: "a", connectorId: "c1" },
        { recordingKey: "b", connectorId: "c1" },
        { recordingKey: "c", connectorId: "c2" },
      ],
    });
    expect(searchOnConnector).toHaveBeenCalledTimes(2);
    const first = searchOnConnector.mock.calls[0][0] as { recordingKeys: string[] };
    expect(first.recordingKeys.sort()).toEqual(["a", "b"]);
  });

  it("never calls the dataplane for an empty query", async () => {
    const run = await subject();
    const res = await run({ tenantId: "t1", query: "   ", candidates: [{ recordingKey: "a", connectorId: "c1" }] });
    expect(searchOnConnector).not.toHaveBeenCalled();
    expect(res.matchedKeys).toEqual([]);
  });

  it("propagates truncation from any connector", async () => {
    searchOnConnector
      .mockResolvedValueOnce({ ok: true, matches: [], truncated: false })
      .mockResolvedValueOnce({ ok: true, matches: [], truncated: true });
    const run = await subject();
    const res = await run({
      tenantId: "t1",
      query: "rm",
      candidates: [
        { recordingKey: "a", connectorId: "c1" },
        { recordingKey: "b", connectorId: "c2" },
      ],
    });
    expect(res.truncated).toBe(true);
  });

  it("skips candidates with no connector rather than throwing", async () => {
    searchOnConnector.mockResolvedValue({ ok: true, matches: [], truncated: false });
    const run = await subject();
    const res = await run({
      tenantId: "t1",
      query: "rm",
      candidates: [{ recordingKey: "a", connectorId: null }],
    });
    expect(searchOnConnector).not.toHaveBeenCalled();
    // A recording whose connector row is gone cannot be searched; saying so beats
    // implying it was searched and matched nothing.
    expect(res.partial).toBe(true);
  });
});
