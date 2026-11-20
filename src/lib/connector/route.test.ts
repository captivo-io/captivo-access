import { describe, expect, it } from "vitest";
import { candidatesFor, newestVersion, routeMembers, type SiteRouting } from "./route";

const conn = (id: string, over: Partial<SiteRouting["connector"]> = {}) => ({ id, name: id, status: "ONLINE" as const, version: "2.44.0", vaultPublicKey: `k-${id}`, ...over });
const grouped = (members: { standby?: boolean; connector: SiteRouting["connector"] }[], probeByConnector: unknown = null): SiteRouting => ({
  connectorId: members[0].connector.id,
  connector: members[0].connector,
  connectorGroup: { id: "g", name: "DC", members: members.map((m) => ({ standby: !!m.standby, connector: m.connector })) },
  probeByConnector: probeByConnector as SiteRouting["probeByConnector"],
});

describe("routeMembers", () => {
  it("returns a lone connector as it is, whatever its state", () => {
    const r: SiteRouting = { connectorId: "a", connector: conn("a", { status: "OFFLINE", version: "2.30.0" }), connectorGroup: null, probeByConnector: null };
    expect(routeMembers(r, { minVersion: "2.39.0" }).eligible.map((m) => m.id)).toEqual(["a"]);
  });

  it("puts active members before standby ones and drops revoked ones", () => {
    const r = grouped([{ standby: true, connector: conn("s") }, { connector: conn("a") }, { connector: conn("x", { status: "REVOKED" }) }, { connector: conn("b") }]);
    const { eligible, excluded } = routeMembers(r);
    expect(eligible.map((m) => [m.id, m.standby])).toEqual([["a", false], ["b", false], ["s", true]]);
    expect(excluded).toEqual([{ member: expect.objectContaining({ id: "x" }), why: "revoked" }]);
  });

  it("leaves out members too old for the relay or without a seal", () => {
    const r = grouped([{ connector: conn("old", { version: "2.38.1" }) }, { connector: conn("new") }, { connector: conn("nokey", { vaultPublicKey: null }) }]);
    const { eligible, excluded } = routeMembers(r, { minVersion: "2.39.0", canOpen: (m) => !!m.vaultPublicKey });
    expect(eligible.map((m) => m.id)).toEqual(["new"]);
    expect(excluded.map((e) => [e.member.id, e.why])).toEqual([["old", "outdated"], ["nokey", "no_seal"]]);
  });

  it("skips a member that can't reach the resource only while another one can", () => {
    const at = new Date().toISOString();
    const some = grouped([{ connector: conn("a") }, { connector: conn("b") }], { a: { ok: false, at }, b: { ok: true, at } });
    expect(routeMembers(some).eligible.map((m) => m.id)).toEqual(["b"]);
    const none = grouped([{ connector: conn("a") }, { connector: conn("b") }], { a: { ok: false, at }, b: { ok: false, at } });
    expect(routeMembers(none).eligible.map((m) => m.id)).toEqual(["a", "b"]);
  });
});

describe("candidatesFor / newestVersion", () => {
  it("marks standby members and adds per-member fields", () => {
    const r = grouped([{ connector: conn("a") }, { standby: true, connector: conn("s") }]);
    expect(candidatesFor(routeMembers(r).eligible, (m) => ({ sealedSecret: `cv1:${m.id}` }))).toEqual([
      { id: "a", sealedSecret: "cv1:a" },
      { id: "s", standby: true, sealedSecret: "cv1:s" },
    ]);
  });
  it("is the newest member's version, dev builds counting as new", () => {
    expect(newestVersion(grouped([{ connector: conn("a", { version: "2.38.0" }) }, { connector: conn("b", { version: "2.40.1" }) }, { connector: conn("r", { version: "9.0.0", status: "REVOKED" }) }]))).toBe("2.40.1");
    expect(newestVersion(grouped([{ connector: conn("a", { version: "2.38.0" }) }, { connector: conn("d", { version: "dev" }) }]))).toBe("dev");
  });
});
