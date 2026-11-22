import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { addTicketNote, lookupTicket, parseSystemDate, TicketSystemError, type SystemSpec } from "./providers";

// A small ServiceNow / Jira / HTTPS endpoint on loopback, answering the way the
// real ones do for the calls we make.
let server: Server;
let base = "";
const seen: { method: string; url: string; auth: string | undefined; body: string }[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ method: req.method!, url: req.url!, auth: req.headers.authorization, body });
      const send = (code: number, j: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(j)); };
      const u = new URL(req.url!, "http://x");
      if (req.headers.authorization === `Basic ${Buffer.from("svc:wrong").toString("base64")}`) return send(401, { error: { message: "User Not Authenticated" } });
      if (u.pathname === "/api/now/table/change_request" && req.method === "GET") {
        if (u.searchParams.get("sysparm_query") !== "number=CHG0030001") return send(200, { result: [] });
        return send(200, { result: [{
          sys_id: { value: "a1b2", display_value: "a1b2" }, number: { value: "CHG0030001", display_value: "CHG0030001" },
          short_description: { value: "Patch CRM", display_value: "Patch CRM" },
          state: { value: "-1", display_value: "Implement" }, approval: { value: "approved", display_value: "Approved" },
          start_date: { value: "2026-11-22 20:00:00", display_value: "22.11.2026 23:00:00" },
          end_date: { value: "2026-11-22 23:00:00", display_value: "23.11.2026 02:00:00" },
          "assigned_to.email": { value: "ana@vendor.com", display_value: "ana@vendor.com" },
        }] });
      }
      if (u.pathname === "/api/now/table/incident") return send(200, { result: [] });
      if (u.pathname === "/api/now/table/change_request/a1b2" && req.method === "PATCH") return send(200, { result: { sys_id: "a1b2" } });
      if (u.pathname === "/rest/api/3/issue/OPS-7") return send(200, { key: "OPS-7", fields: { summary: "Rotate keys", status: { name: "Implementing" }, assignee: { emailAddress: "ana@vendor.com" }, customfield_10015: "2026-11-22T20:00:00.000+0000" } });
      if (u.pathname === "/rest/servicedeskapi/request/OPS-7/approval") return send(200, { values: [{ finalDecision: "approved" }, { finalDecision: "pending" }] });
      if (u.pathname === "/rest/api/3/issue/OPS-404") return send(404, { errorMessages: ["Issue does not exist"] });
      if (u.pathname === "/rest/api/3/issue/OPS-7/comment") return send(201, { id: "1" });
      if (u.pathname === "/hook") {
        const b = JSON.parse(body);
        if (b.event === "ticket.note") return send(200, { ok: true });
        if (b.ticket === "NONE-1") return send(200, { found: false });
        return send(200, { valid: b.user.email.endsWith("@vendor.com"), approved: true, state: "Go", endsAt: "2026-11-22T23:00:00Z", reason: "not a vendor" });
      }
      send(404, {});
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const sn = (): SystemSpec => ({ kind: "servicenow", baseUrl: base, username: "svc", tables: ["change_request", "incident"], startField: null, endField: null });
const jira = (): SystemSpec => ({ kind: "jira", baseUrl: base, username: "bot@acme.com", tables: [], startField: "customfield_10015", endField: null });
const ctx = { user: { email: "ana@vendor.com", name: "Ana" }, resource: null, workspace: "acme" };

describe("ServiceNow", () => {
  it("reads a change with its state, approval, window and assignee", async () => {
    const f = await lookupTicket(sn(), "pw", "CHG0030001", ctx);
    expect(f).toMatchObject({ ref: "CHG0030001", title: "Patch CRM", state: "Implement", approved: true, rejected: false, assignee: "ana@vendor.com", table: "change_request", sysId: "a1b2" });
    expect(f!.start!.toISOString()).toBe("2026-11-22T20:00:00.000Z"); // the stored value is UTC, not the display zone
    expect(f!.url).toBe(`${base}/change_request.do?sys_id=a1b2`);
    expect(seen.at(-1)!.auth).toBe(`Basic ${Buffer.from("svc:pw").toString("base64")}`);
  });
  it("answers not found, and a refused login as an error", async () => {
    expect(await lookupTicket(sn(), "pw", "CHG0099999", ctx)).toBeNull();
    await expect(lookupTicket(sn(), "wrong", "CHG0030001", ctx)).rejects.toMatchObject({ reason: "auth" });
  });
  it("adds a work note to the record", async () => {
    await addTicketNote(sn(), "pw", { ref: "CHG0030001", table: "change_request", sysId: "a1b2" }, "open", "hello");
    expect(seen.at(-1)).toMatchObject({ method: "PATCH", body: JSON.stringify({ work_notes: "hello" }) });
  });
});

describe("Jira", () => {
  it("reads an issue, its window field and its service desk approvals", async () => {
    const f = await lookupTicket(jira(), "tok", "OPS-7", ctx);
    expect(f).toMatchObject({ ref: "OPS-7", state: "Implementing", approved: false, rejected: false, assignee: "ana@vendor.com", url: `${base}/browse/OPS-7` });
    expect(f!.start!.toISOString()).toBe("2026-11-22T20:00:00.000Z");
    expect(await lookupTicket(jira(), "tok", "OPS-404", ctx)).toBeNull();
  });
  it("adds an internal comment", async () => {
    await addTicketNote(jira(), "tok", { ref: "OPS-7", table: null, sysId: null }, "close", "bye");
    const b = JSON.parse(seen.at(-1)!.body);
    expect(b.properties).toEqual([{ key: "sd.public.comment", value: { internal: true } }]);
    expect(b.body.content[0].content[0].text).toBe("bye");
  });
});

describe("HTTPS endpoint", () => {
  const hook = (): SystemSpec => ({ kind: "https", baseUrl: `${base}/hook`, username: null, tables: [], startField: null, endField: null });
  it("lets the endpoint answer", async () => {
    expect(await lookupTicket(hook(), "t", "X-1", ctx)).toMatchObject({ valid: true, approved: true, state: "Go" });
    expect(await lookupTicket(hook(), "t", "X-1", { ...ctx, user: { email: "eve@else.com", name: null } })).toMatchObject({ valid: false, reason: "not a vendor" });
    expect(await lookupTicket(hook(), "t", "NONE-1", ctx)).toBeNull();
    expect(seen.at(-1)!.auth).toBe("Bearer t");
  });
});

describe("unreachable", () => {
  it("is a TicketSystemError", async () => {
    const dead: SystemSpec = { ...sn(), baseUrl: "http://127.0.0.1:1" };
    await expect(lookupTicket(dead, "pw", "CHG0030001", ctx)).rejects.toBeInstanceOf(TicketSystemError);
  });
});

describe("parseSystemDate", () => {
  it("reads the systems' date forms", () => {
    expect(parseSystemDate("2026-11-22 10:00:00")?.toISOString()).toBe("2026-11-22T10:00:00.000Z");
    expect(parseSystemDate("2026-11-22T10:00:00.000+0300")?.toISOString()).toBe("2026-11-22T07:00:00.000Z");
    expect(parseSystemDate("")).toBeNull();
    expect(parseSystemDate("soon")).toBeNull();
  });
});
