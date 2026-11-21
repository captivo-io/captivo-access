import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/audit/admin", () => ({ recordAdminAction: vi.fn() }));
vi.mock("@/lib/connector/history", () => ({ recordConnectorEvent: vi.fn() }));

import { canReshare, planFor, runGroupReshare, type ResharePlan } from "./reshare";

const SEAL = (n: number) => "cv1:" + Buffer.alloc(60, n).toString("base64");
const member = (id: string, over: Partial<{ status: string; version: string | null; vaultPublicKey: string | null }> = {}) => ({
  connector: { id, name: id.toUpperCase(), status: "ONLINE", version: "2.44.0", vaultPublicKey: `k-${id}`, ...over },
});
const cred = (members: ReturnType<typeof member>[], seals: Record<string, string>) => {
  const [first, ...rest] = Object.entries(seals);
  return {
    id: "vc1", secret: first[1], sealedTo: first[0], extraSeals: Object.fromEntries(rest),
    site: { id: "s1", name: "DC-01", members },
    target: { host: "10.0.0.5", port: 3389, username: "admin" },
  };
};

describe("canReshare", () => {
  it("takes an online connector on 2.44.0 or later, or a dev build", () => {
    expect(canReshare({ status: "ONLINE", version: "2.44.0" })).toBe(true);
    expect(canReshare({ status: "ONLINE", version: "dev" })).toBe(true);
    expect(canReshare({ status: "ONLINE", version: "2.43.1" })).toBe(false);
    expect(canReshare({ status: "OFFLINE", version: "2.44.0" })).toBe(false);
    expect(canReshare({ status: "ONLINE", version: null })).toBe(false);
  });
});

describe("planFor", () => {
  it("has a member holding a copy give it to the members without one", () => {
    const p = planFor(cred([member("a"), member("b"), member("c")], { "k-a": SEAL(1) }));
    expect(p?.source).toEqual({ id: "a", name: "A" });
    expect(p?.item.to).toEqual({ "k-b": { id: "b", name: "B" }, "k-c": { id: "c", name: "C" } });
  });

  it("skips givers that are offline or too old, and gives nothing to revoked or keyless members", () => {
    const p = planFor(cred([member("a", { status: "OFFLINE" }), member("b", { version: "2.43.1" }), member("c"), member("r", { status: "REVOKED" }), member("n", { vaultPublicKey: null }), member("d")], { "k-a": SEAL(1), "k-b": SEAL(2), "k-c": SEAL(3) }));
    expect(p?.source.id).toBe("c");
    expect(Object.keys(p!.item.to)).toEqual(["k-d"]);
  });

  it("does nothing when everyone has a copy, nobody can give one, or the secret is legacy", () => {
    expect(planFor(cred([member("a"), member("b")], { "k-a": SEAL(1), "k-b": SEAL(2) }))).toBeNull();
    expect(planFor(cred([member("a", { version: "2.43.1" }), member("b")], { "k-a": SEAL(1) }))).toBeNull();
    expect(planFor({ ...cred([member("a"), member("b")], { "k-a": SEAL(1) }), sealedTo: null })).toBeNull();
  });
});

describe("runGroupReshare", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("keeps only seals for the keys it asked for, in the sealed format", async () => {
    const plan: ResharePlan = [{
      source: { id: "a", name: "A" }, sourceKey: "k-a",
      items: [{ credentialId: "vc1", siteId: "s1", siteName: "DC-01", secret: SEAL(1), sealedTo: "k-a", seals: { "k-a": SEAL(1) }, target: { host: "h", port: 22, username: "u" }, to: { "k-b": { id: "b", name: "B" } } }],
    }];
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ items: [{ id: "vc1", seals: { "k-b": SEAL(9), "k-evil": SEAL(8) } }, { id: "other", seals: { "k-b": SEAL(7) } }] })));
    vi.stubGlobal("fetch", fetchMock);
    const out = await runGroupReshare(plan);
    expect(out.get("vc1")).toEqual({ "k-b": SEAL(9) });
    expect(out.has("other")).toBe(false);
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body).toEqual({ connectorId: "a", items: [{ id: "vc1", sealed: SEAL(1), host: "h", port: "22", username: "u", to: ["k-b"] }] });
  });

  it("leaves the batch for the next pass when the connector does not answer", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 502 })));
    const plan: ResharePlan = [{ source: { id: "a", name: "A" }, sourceKey: "k-a", items: [] }];
    plan[0].items.push({ credentialId: "vc1", siteId: "s1", siteName: "x", secret: SEAL(1), sealedTo: "k-a", seals: { "k-a": SEAL(1) }, target: { host: "h", port: 22, username: "u" }, to: { "k-b": { id: "b", name: "B" } } });
    expect((await runGroupReshare(plan)).size).toBe(0);
  });
});
