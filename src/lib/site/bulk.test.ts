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
  it("moves a sealed resource only where one of its seals opens", () => {
    const sites = [
      { id: "rdp", accessMode: "GATEWAY", connectorId: "c1", sealed: true, sealedKeys: ["k1"] },
      { id: "grp", accessMode: "GATEWAY", connectorId: "c1", connectorGroupId: "g1", sealed: true, sealedKeys: ["k1", "k2"] },
      { id: "web", accessMode: "TRANSPARENT", connectorId: "c1", sealed: false },
    ];
    // Into a group that keeps c1 (key k1): all three go.
    expect(planMove(sites, { connectorGroupId: "g2", keys: ["k1", "k3"] })).toEqual({ move: ["rdp", "grp", "web"], sealed: [], already: [] });
    // Into a group without c1: the sealed ones stay; the group's own resource is already there.
    expect(planMove(sites, { connectorGroupId: "g1", keys: ["k3"] })).toEqual({ move: ["web"], sealed: ["rdp"], already: ["grp"] });
    // Out of a group onto its member c2: the group resource's seal for k2 opens there.
    expect(planMove(sites, { connectorId: "c2", keys: ["k2"] })).toEqual({ move: ["grp", "web"], sealed: ["rdp"], already: [] });
  });
});
