import { beforeEach, describe, expect, it, vi } from "vitest";

const s = vi.hoisted(() => ({
  original: null as string | null,
  copies: [] as { connectorId: string; state: string }[],
  online: new Set<string>(),
  held: new Map<string, number>(), // connector -> total bytes it answers with
  asked: [] as string[],
  cancelled: 0,
}));

vi.mock("@/lib/db", () => ({ db: { recordingReplica: { findMany: async () => s.copies } } }));
vi.mock("@/lib/tenant/context", () => ({ currentTenantId: () => "t1" }));
vi.mock("./connector-of", () => ({ connectorForRecording: async () => s.original }));
vi.mock("@/lib/dataplane/recordings", () => ({
  fetchFromConnector: async (i: { connectorId: string; format: string }) => {
    s.asked.push(`${i.connectorId}:${i.format}`);
    if (!s.online.has(i.connectorId)) return null;
    return { body: { cancel: async () => { s.cancelled++; } } as unknown as ReadableStream<Uint8Array>, totalBytes: s.held.get(i.connectorId) ?? 0 };
  },
}));

import { copyServes, fetchFromHolders, isFailure } from "./holders";
import { holderNotice, mainStreamOf } from "./holder-notice";

const rec = { id: "r1", siteId: "s", recordingKey: "k", protocol: "ssh" as string | null, format: "GUAC" };

describe("who plays a recording", () => {
  beforeEach(() => {
    s.original = "A";
    s.copies = [];
    s.online = new Set(["A", "B", "C"]);
    s.held = new Map([["A", 100], ["B", 100], ["C", 50]]);
    s.asked = [];
    s.cancelled = 0;
  });

  it("asks the original first and uses a copy only when the original cannot answer", async () => {
    s.copies = [{ connectorId: "B", state: "COMPLETE" }];
    const r = await fetchFromHolders(rec, "guac");
    expect(isFailure(r) ? null : [r.connectorId, r.copy]).toEqual(["A", false]);
    expect(s.asked).toEqual(["A:guac"]);
    s.online.delete("A");
    s.asked = [];
    const r2 = await fetchFromHolders(rec, "guac");
    expect(isFailure(r2) ? null : [r2.connectorId, r2.copy]).toEqual(["B", true]);
    expect(s.asked).toEqual(["A:guac", "B:guac"]);
  });

  it("prefers a complete copy over one still being made, and skips a copy that does not hold the stream yet", async () => {
    s.online.delete("A");
    s.copies = [{ connectorId: "C", state: "COPYING" }, { connectorId: "B", state: "COMPLETE" }];
    const r = await fetchFromHolders(rec, "guac");
    expect(isFailure(r) ? null : r.connectorId).toBe("B");
    s.copies = [{ connectorId: "C", state: "COPYING" }];
    s.held.set("C", 0); // answers, but holds nothing of this stream
    s.asked = [];
    expect(await fetchFromHolders(rec, "guac")).toEqual({ error: "connector_offline" });
    expect(s.cancelled).toBe(1);
  });

  it("is offline when nobody answers, and no connector when nobody could", async () => {
    s.online.clear();
    s.copies = [{ connectorId: "B", state: "COMPLETE" }];
    expect(await fetchFromHolders(rec, "guac")).toEqual({ error: "connector_offline" });
    s.original = null;
    s.copies = [];
    expect(await fetchFromHolders(rec, "guac")).toEqual({ error: "no_connector" });
  });

  it("a graphical session's copy serves video and keystrokes, never the raw screen, and a half video not at all", async () => {
    const rdp = { ...rec, protocol: "rdp", format: "GUAC" };
    s.online.delete("A");
    s.copies = [{ connectorId: "B", state: "COMPLETE" }];
    expect(await fetchFromHolders(rdp, "guac")).toEqual({ error: "connector_offline" });
    expect(s.asked).toEqual(["A:guac"]); // the copy was not even asked for the raw stream
    const v = await fetchFromHolders(rdp, "video");
    expect(isFailure(v) ? null : v.connectorId).toBe("B");
    s.copies = [{ connectorId: "B", state: "COPYING" }];
    expect(await fetchFromHolders(rdp, "video")).toEqual({ error: "connector_offline" });
    expect(copyServes({ protocol: "vnc" }, "rdp", true)).toBe(false);
    expect(copyServes({ protocol: "ssh" }, "guac", false)).toBe(true);
    expect(copyServes({ protocol: null }, "rrweb", false)).toBe(true);
  });

  it("a recording without an id has no copies to ask", async () => {
    s.original = "A";
    s.online.delete("A");
    expect(await fetchFromHolders({ siteId: "s", recordingKey: "k", protocol: "ssh" }, "guac")).toEqual({ error: "connector_offline" });
  });
});

describe("what the recording page says", () => {
  const now = new Date("2026-11-28T12:00:00Z");
  const ssh = { format: "GUAC", videoReady: false, protocol: "ssh" };
  const off = { name: "LAB", online: false, lastSeenAt: new Date("2026-11-28T10:00:00Z") };
  it("nothing while the original is online or unknown", () => {
    expect(holderNotice(ssh, { ...off, online: true }, [], now)).toEqual({ kind: "none" });
    expect(holderNotice(ssh, null, [], now)).toEqual({ kind: "none" });
  });
  it("offline with no usable copy; with copies that are offline too", () => {
    expect(holderNotice(ssh, off, [], now)).toEqual({ kind: "offline", original: "LAB", since: "2 h ago", copiesElsewhere: [] });
    const home = { name: "Home", online: false, lastSeenAt: null, complete: true };
    expect(holderNotice(ssh, off, [home], now)).toMatchObject({ kind: "offline", copiesElsewhere: ["Home"] });
  });
  it("from a copy, a complete one before a partial one", () => {
    const partial = { name: "P", online: true, lastSeenAt: null, complete: false };
    const whole = { name: "W", online: true, lastSeenAt: null, complete: true };
    expect(holderNotice(ssh, off, [partial, whole], now)).toMatchObject({ kind: "from_copy", copy: "W", complete: true });
    expect(holderNotice(ssh, off, [partial], now)).toMatchObject({ kind: "from_copy", copy: "P", complete: false });
  });
  it("a graphical recording is not playable from a copy that has no video yet", () => {
    const rdp = { format: "GUAC", videoReady: false, protocol: "rdp" };
    const home = { name: "Home", online: true, lastSeenAt: null, complete: true };
    expect(holderNotice(rdp, off, [home], now).kind).toBe("offline");
    expect(holderNotice({ ...rdp, videoReady: true }, off, [home], now).kind).toBe("from_copy");
    expect(mainStreamOf({ format: "VIDEO", videoReady: false })).toBe("video");
    expect(mainStreamOf({ format: "RDP", videoReady: false })).toBe("rdp");
    expect(mainStreamOf({ format: "TERM", videoReady: false })).toBe("term");
  });
});
