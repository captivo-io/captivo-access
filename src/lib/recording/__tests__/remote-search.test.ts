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

// Braces matter: a function returned from beforeEach is run as its teardown, and mockReset() returns the mock.
beforeEach(() => {
  searchOnConnector.mockReset();
});

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

describe("searching a recording whose original connector is down", () => {
  type Ask = { connectorId: string; recordingKeys: string[] };
  const answer = (down: string[]) => async (i: Ask) => {
    return down.includes(i.connectorId)
      ? { ok: false, error: "connector offline" }
      : { ok: true, matches: i.recordingKeys.map((k) => ({ recordingKey: k, seq: 0, snippet: "rm" })), truncated: false };
  };

  it("asks a copy instead, and the answer is complete when the copy answers", async () => {
    searchOnConnector.mockImplementation(answer(["c1"]));
    const run = await subject();
    const res = await run({
      tenantId: "t1",
      query: "rm",
      candidates: [
        { recordingKey: "a", connectorId: "c1", alternates: ["c2"] },
        { recordingKey: "b", connectorId: "c2" },
      ],
    });
    expect(res.matchedKeys.sort()).toEqual(["a", "b"]);
    expect(res.partial, "a copy answered for the recording whose original is down").toBe(false);
    expect(res.unreachableConnectors).toEqual(["c1"]);
  });

  it("is partial when the original and every copy are down, and tries each copy once", async () => {
    searchOnConnector.mockImplementation(answer(["c1", "c2", "c3"]));
    const run = await subject();
    const res = await run({ tenantId: "t1", query: "rm", candidates: [{ recordingKey: "a", connectorId: "c1", alternates: ["c2", "c3"] }] });
    expect(res.matchedKeys).toEqual([]);
    expect(res.partial).toBe(true);
    expect(searchOnConnector.mock.calls.map((c) => (c[0] as { connectorId: string }).connectorId)).toEqual(["c1", "c2", "c3"]);
  });

  it("a recording with no original connector but a copy is still searched", async () => {
    searchOnConnector.mockImplementation(answer([]));
    const run = await subject();
    const res = await run({ tenantId: "t1", query: "rm", candidates: [{ recordingKey: "a", connectorId: null, alternates: ["c2"] }] });
    expect(res.matchedKeys).toEqual(["a"]);
    expect(res.partial).toBe(false);
  });

  it("a match found on two holders is one match", async () => {
    searchOnConnector.mockImplementation(answer([]));
    const run = await subject();
    const res = await run({ tenantId: "t1", query: "rm", candidates: [{ recordingKey: "a", connectorId: "c1", alternates: ["c2"] }, { recordingKey: "a", connectorId: "c2" }] });
    expect(res.matchedKeys).toEqual(["a"]);
  });

  it("a copy that is also down is not asked for every recording again", async () => {
    searchOnConnector.mockImplementation(answer(["c1", "c2"]));
    const run = await subject();
    const res = await run({
      tenantId: "t1",
      query: "rm",
      candidates: [
        { recordingKey: "a", connectorId: "c1", alternates: ["c2", "c3"] },
        { recordingKey: "b", connectorId: "c1", alternates: ["c2", "c3"] },
      ],
    });
    expect(res.matchedKeys.sort()).toEqual(["a", "b"]);
    expect(res.partial).toBe(false);
    expect(searchOnConnector.mock.calls.map((c) => (c[0] as { connectorId: string }).connectorId)).toEqual(["c1", "c2", "c3"]);
  });
});
