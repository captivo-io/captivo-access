import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

// The data plane answers with every tenant's sessions; the site lookup runs
// under the request tenant's RLS, so this mock plays "the sites this tenant can see".
const siteFindMany = vi.fn();
vi.mock("@/lib/db", () => ({ db: { site: { findMany: (...a: unknown[]) => siteFindMany(...a) } } }));

import { listActiveSessions, listActiveWebSessions, findOwnSession, terminateSession, setSessionControl } from "../client";

const gateway = [
  { sessionId: "s_own", siteId: "site_own", userId: "u1", kind: "gateway", protocol: "rdp", host: "h1", startedAt: "", viewerCount: 0, controlOwner: "" },
  { sessionId: "s_other", siteId: "site_other", userId: "u9", kind: "gateway", protocol: "ssh", host: "h9", startedAt: "", viewerCount: 0, controlOwner: "" },
];
const web = [
  { userId: "u1", siteId: "site_own", host: "a.example", startedAt: "", lastSeen: "" },
  { userId: "u9", siteId: "site_other", host: "b.example", startedAt: "", lastSeen: "" },
];

const fetchMock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  siteFindMany.mockImplementation(async (q: { where: { id: { in: string[] } } }) =>
    q.where.id.in.filter((id) => id === "site_own").map((id) => ({ id })));
  fetchMock.mockImplementation(async (url: string) => {
    const body = url.endsWith("/sessions") ? gateway : url.endsWith("/web-sessions") ? web : { ok: true, found: true };
    return new Response(JSON.stringify(body), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("live sessions are scoped to the current tenant", () => {
  it("lists drop sessions on another tenant's sites", async () => {
    expect((await listActiveSessions()).map((s) => s.sessionId)).toEqual(["s_own"]);
    expect((await listActiveWebSessions()).map((s) => s.host)).toEqual(["a.example"]);
  });

  it("an empty registry never asks the database", async () => {
    fetchMock.mockResolvedValue(new Response("[]", { status: 200 }));
    expect(await listActiveSessions()).toEqual([]);
    expect(siteFindMany).not.toHaveBeenCalled();
  });

  it("another tenant's session id is not found", async () => {
    expect(await findOwnSession("s_other")).toBeNull();
    expect((await findOwnSession("s_own"))?.siteId).toBe("site_own");
  });

  it("terminate and control never reach the data plane for a foreign session", async () => {
    expect(await terminateSession("s_other")).toEqual({ ok: true, found: false });
    expect(await setSessionControl("s_other", "admin", "take")).toEqual({ ok: false, reason: "not_found" });
    const actions = fetchMock.mock.calls.map((c) => String(c[0])).filter((u) => /terminate|control/.test(u));
    expect(actions).toEqual([]);
  });

  it("an own session is still terminated", async () => {
    expect(await terminateSession("s_own")).toEqual({ ok: true, found: true });
    expect(fetchMock.mock.calls.some((c) => String(c[0]).endsWith("/sessions/terminate"))).toBe(true);
  });
});
