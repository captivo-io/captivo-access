import { describe, expect, it } from "vitest";
import { BULK_MAX, parseBulk, planMove } from "./bulk";

describe("parseBulk", () => {
  it("accepts a delete and drops duplicate ids", () => {
    expect(parseBulk({ action: "delete", ids: ["a", "b", "a"] })).toEqual({ action: "delete", ids: ["a", "b"] });
  });
  it("needs a target connector for a move", () => {
    expect(parseBulk({ action: "move", ids: ["a"] })).toEqual({ error: "connector_required" });
    expect(parseBulk({ action: "move", ids: ["a"], connectorId: "c2" })).toEqual({ action: "move", ids: ["a"], connectorId: "c2" });
  });
  it("refuses junk", () => {
    expect(parseBulk({ action: "nuke", ids: ["a"] })).toEqual({ error: "invalid_action" });
    expect(parseBulk({ action: "delete", ids: [] })).toEqual({ error: "invalid_ids" });
    expect(parseBulk({ action: "delete", ids: [1] })).toEqual({ error: "invalid_ids" });
    expect(parseBulk({ action: "delete", ids: Array.from({ length: BULK_MAX + 1 }, (_, i) => `s${i}`) })).toEqual({ error: "too_many" });
  });
});

describe("planMove", () => {
  it("keeps sealed remote-desktop resources and those already on the target", () => {
    const p = planMove([
      { id: "web", accessMode: "TRANSPARENT", connectorId: "c1", sealed: false },
      { id: "iso", accessMode: "ISOLATED", connectorId: "c1", sealed: false },
      { id: "rdp", accessMode: "GATEWAY", connectorId: "c1", sealed: true },
      { id: "legacy", accessMode: "GATEWAY", connectorId: "c1", sealed: false },
      { id: "there", accessMode: "TRANSPARENT", connectorId: "c2", sealed: false },
    ], "c2");
    expect(p).toEqual({ move: ["web", "iso", "legacy"], sealed: ["rdp"], already: ["there"] });
  });
});
