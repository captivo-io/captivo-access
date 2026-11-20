import { describe, expect, it } from "vitest";
import { accessRecord, adminRecord, sampleRecords, testRecord, wanted, type AccessRow } from "./records";
import { cef, datadogBody, genericBody, jsonEvent, splunkHecBody, syslogLine, type FormatContext } from "./format";

const ctx: FormatContext = { version: "2.42.0", hostname: "acme.cloud.captivo.io", workspace: "acme" };
const at = new Date("2026-11-20T09:14:03.120Z");

function row(over: Partial<AccessRow> = {}): AccessRow {
  return {
    seq: BigInt(7), timestamp: at, userEmail: "ayse@vendor.example", userName: "Ayşe", company: "Vendor", siteId: "s1", siteName: "DC01",
    host: "dc01.corp.local", method: "GET", path: "/", status: 0, bytesOut: BigInt(0), decision: "ALLOW", reason: "session_open",
    clientIp: "203.0.113.24", userAgent: "UA", hash: "h", ...over,
  };
}

describe("records", () => {
  it("names sessions, transfers, requests and denials", () => {
    expect(accessRecord(row()).action).toBe("session.open");
    expect(accessRecord(row({ reason: "session_close 12m" })).message).toBe("ayse@vendor.example closed the session to DC01 after 12m");
    expect(accessRecord(row({ method: "RDG_OUT_DATA", reason: "session_open native_rdp" })).message).toContain("with their own RDP app");
    expect(accessRecord(row({ method: "UPLOAD", path: "/drive/report.xlsx", reason: "file:application/zip" }))).toMatchObject({ category: "file", action: "file.upload" });
    expect(accessRecord(row({ reason: null, method: "POST", path: "/api/x" }))).toMatchObject({ category: "request", action: "access.request" });
    const deny = accessRecord(row({ reason: "off_schedule", decision: "DENY", status: 403 }));
    expect(deny).toMatchObject({ category: "request", action: "access.deny", outcome: "deny" });
    expect(deny.message).toContain("denied, outside the grant's hours");
  });

  it("files the console's own rows with admin activity", () => {
    expect(accessRecord(row({ host: "manager", method: "DELETE", reason: "Requested erasure of session recording" }))).toMatchObject({ category: "admin", action: "system.delete" });
  });

  it("sends a denial when either switch asks for it", () => {
    const sel = { sendSessions: false, sendFiles: false, sendDenied: true, sendAdmin: false, sendRequests: false };
    expect(wanted(sel, accessRecord(row({ decision: "DENY", reason: "no_grant" })))).toBe(true);
    expect(wanted(sel, accessRecord(row()))).toBe(false);
    expect(wanted({ ...sel, sendDenied: false, sendRequests: true }, accessRecord(row({ decision: "DENY", reason: null })))).toBe(true);
    expect(wanted({ ...sel, sendAdmin: true }, adminRecord({ seq: BigInt(1), timestamp: at, actorEmail: "a@b", action: "grant.create", targetType: null, targetId: null, summary: "x", clientIp: null, hash: "" }))).toBe(true);
  });
});

describe("CEF", () => {
  it("escapes the header and the extensions", () => {
    const r = { ...testRecord("a@b.c", at), name: "Pipe | and \\ slash", message: "a=b\nnext" };
    const line = cef(r, ctx);
    expect(line.startsWith("CEF:0|Captivo|Access|2.42.0|test|Pipe \\| and \\\\ slash|5|")).toBe(true);
    expect(line).toContain("msg=a\\=b\\nnext");
    expect(line).not.toContain("\n");
  });

  it("carries the fields a SIEM maps", () => {
    const line = cef(accessRecord(row({ decision: "DENY", reason: "no_grant", method: "POST", path: "/login", status: 403 })), ctx);
    expect(line).toContain("|access.deny|Access denied|7|");
    for (const kv of [`rt=${at.getTime()}`, "act=access.deny", "outcome=deny", "suser=ayse@vendor.example", "src=203.0.113.24", "dhost=dc01.corp.local", "requestMethod=POST", "request=/login", "cs1Label=Resource cs1=DC01", "cn1Label=HttpStatus cn1=403", "externalId=access-7"]) {
      expect(line).toContain(kv);
    }
  });
});

describe("syslog", () => {
  it("writes an RFC 5424 header with the facility and severity", () => {
    const line = syslogLine(accessRecord(row()), ctx, { format: "cef", facility: 16 });
    expect(line.startsWith("<134>1 2026-11-20T09:14:03.120Z acme.cloud.captivo.io captivo-access - session - CEF:0|")).toBe(true);
    const deny = syslogLine(accessRecord(row({ decision: "DENY", reason: "no_grant" })), ctx, { format: "json", facility: 10 });
    expect(deny.startsWith("<84>1 ")).toBe(true);
    expect(JSON.parse(deny.slice(deny.indexOf("{")))).toMatchObject({ action: "access.deny", outcome: "deny", workspace: "acme" });
  });

  it("keeps the header fields printable", () => {
    const line = syslogLine(testRecord(null, at), { ...ctx, hostname: "bad host ç" }, { format: "cef", facility: 16 });
    expect(line.split(" ")[2]).toBe("badhost");
  });
});

describe("cloud bodies", () => {
  const recs = sampleRecords(at);

  it("Splunk HEC: one event object per line", () => {
    const lines = splunkHecBody(recs, ctx).split("\n").map((l) => JSON.parse(l));
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatchObject({ time: at.getTime() / 1000, host: "acme.cloud.captivo.io", source: "captivo-access", sourcetype: "captivo:access" });
    expect(lines[0].event.action).toBe("session.open");
  });

  it("Datadog: an array with source, tags and status", () => {
    const arr = JSON.parse(datadogBody(recs, ctx));
    expect(arr[1]).toMatchObject({ ddsource: "captivo-access", service: "captivo-access", status: "warn" });
    expect(arr[1].ddtags).toBe("workspace:acme,category:request,outcome:deny");
  });

  it("generic: the JSON events", () => {
    expect(JSON.parse(genericBody(recs, ctx))).toEqual(recs.map((r) => JSON.parse(JSON.stringify(jsonEvent(r, ctx)))));
  });

  it("leaves empty fields out of the JSON event", () => {
    const e = jsonEvent(testRecord(null, at), ctx);
    expect(e).not.toHaveProperty("user");
    expect(e).not.toHaveProperty("http");
    expect(e.log).toEqual({ source: "admin", seq: "0", hash: "" });
  });
});

describe("session records", () => {
  it("leave out the reason and status that only restate the event", () => {
    const line = cef(accessRecord(row({ status: 101 })), ctx);
    expect(line).not.toContain("cs2Label");
    expect(line).not.toContain("cn1=");
  });
});
