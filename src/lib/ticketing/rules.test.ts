import { describe, it, expect } from "vitest";
import { clampToWindow, effectiveMode, normalizeRef, noteText, readSnapshot, snapshot, tablesFor, verdict, type TicketFacts } from "./rules";

const facts = (over: Partial<TicketFacts> = {}): TicketFacts => ({
  ref: "CHG0030001", title: "Patch CRM", state: "Implement", approved: true, start: null, end: null, assignee: "ana@vendor.com", url: null, ...over,
});
const now = new Date("2026-11-22T12:00:00Z");
const sn = { kind: "servicenow" as const, allowedStates: [], matchAssignee: false };

describe("effectiveMode", () => {
  it("takes the resource's rule, else the workspace's, and needs a system for itsm", () => {
    expect(effectiveMode(null, null)).toBe("off");
    expect(effectiveMode(null, { kind: "servicenow", defaultMode: "itsm" })).toBe("itsm");
    expect(effectiveMode("off", { kind: "servicenow", defaultMode: "itsm" })).toBe("off");
    expect(effectiveMode("itsm", { kind: "none", defaultMode: "off" })).toBe("required");
    expect(effectiveMode("bogus", { kind: "jira", defaultMode: "required" })).toBe("off");
  });
});

describe("normalizeRef", () => {
  it("tidies numbers and refuses what can't be one", () => {
    expect(normalizeRef(" chg0030001 ", "servicenow")).toBe("CHG0030001");
    expect(normalizeRef("ops-12", "jira")).toBe("OPS-12");
    expect(normalizeRef("OPS12", "jira")).toBeNull();
    expect(normalizeRef("CHG1^ORDERBY", "servicenow")).toBeNull(); // no ServiceNow query syntax
    expect(normalizeRef("", "none")).toBeNull();
    expect(normalizeRef("ticket #42", "none")).toBeNull();
    expect(normalizeRef("RT#42", "none")).toBe("RT#42");
  });
});

describe("tablesFor", () => {
  it("looks a number up where its prefix says, only when that table is on", () => {
    expect(tablesFor("CHG0030001", ["change_request", "incident"])).toEqual(["change_request"]);
    expect(tablesFor("CTASK0010001", ["change_task", "change_request"])).toEqual(["change_task"]);
    expect(tablesFor("INC0010001", ["change_request"])).toEqual([]);
    expect(tablesFor("X-1", ["change_request", "incident"])).toEqual(["change_request", "incident"]);
  });
});

describe("verdict", () => {
  const who = { email: "ana@vendor.com" };
  it("allows an open ticket and says whether it is approved", () => {
    expect(verdict(facts(), sn, who, now)).toEqual({ ok: true, approved: true });
    expect(verdict(facts({ approved: null }), sn, who, now)).toEqual({ ok: true, approved: false });
  });
  it("refuses a missing, closed, rejected, someone else's or finished ticket", () => {
    expect(verdict(null, sn, who, now)).toMatchObject({ ok: false, why: "not_found" });
    expect(verdict(facts({ state: "Closed" }), sn, who, now)).toMatchObject({ ok: false, why: "state", detail: "Closed" });
    expect(verdict(facts({ rejected: true, approved: false }), sn, who, now)).toMatchObject({ ok: false, why: "rejected" });
    expect(verdict(facts({ assignee: "bob@vendor.com" }), { ...sn, matchAssignee: true }, who, now)).toMatchObject({ ok: false, why: "assignee" });
    expect(verdict(facts({ assignee: null }), { ...sn, matchAssignee: true }, who, now)).toMatchObject({ ok: false, why: "assignee" });
    expect(verdict(facts({ end: new Date("2026-11-22T11:00:00Z") }), sn, who, now)).toMatchObject({ ok: false, why: "window_over" });
  });
  it("matches states without case, from the workspace's own list when it has one", () => {
    expect(verdict(facts({ state: "implement" }), sn, who, now).ok).toBe(true);
    expect(verdict(facts({ state: "Implement" }), { ...sn, allowedStates: ["Scheduled"] }, who, now).ok).toBe(false);
  });
  it("lets an HTTPS endpoint decide", () => {
    const https = { kind: "https" as const, allowedStates: [], matchAssignee: false };
    expect(verdict(facts({ valid: true, state: "whatever" }), https, who, now).ok).toBe(true);
    expect(verdict(facts({ valid: false, reason: "frozen" }), https, who, now)).toMatchObject({ ok: false, why: "rejected", detail: "frozen" });
  });
});

describe("clampToWindow", () => {
  it("fits the access into the change window", () => {
    const w = { start: new Date("2026-11-22T20:00:00Z"), end: new Date("2026-11-22T23:00:00Z") };
    const r = clampToWindow(now, new Date("2026-11-23T12:00:00Z"), w, now);
    expect(r).toEqual({ startsAt: w.start, endsAt: w.end, clamped: true });
    const inside = clampToWindow(new Date("2026-11-22T21:00:00Z"), new Date("2026-11-22T22:00:00Z"), w, now);
    expect(inside.clamped).toBe(false);
    expect(clampToWindow(null, null, { start: null, end: null }, now)).toEqual({ startsAt: null, endsAt: null, clamped: false });
    expect(clampToWindow(null, null, { start: null, end: w.end }, now).endsAt).toEqual(w.end);
  });
});

describe("snapshot", () => {
  it("round-trips through JSON", () => {
    const s = snapshot("servicenow", facts({ table: "change_request", sysId: "abc", end: new Date("2026-11-22T23:00:00Z") }));
    expect(readSnapshot(JSON.parse(JSON.stringify(s)))).toMatchObject({ system: "servicenow", table: "change_request", sysId: "abc", end: "2026-11-22T23:00:00.000Z", approved: true });
    expect(readSnapshot(null)).toBeNull();
  });
});

describe("noteText", () => {
  const base = { who: "Ana", email: "ana@vendor.com", site: "CRM", at: new Date("2026-11-22T20:05:09.120Z"), recordingsUrl: "https://acme/admin/recordings?q=CHG1" };
  it("says who opened what, with the recordings link", () => {
    expect(noteText({ ...base, reason: "session_open" })).toEqual({ kind: "open", body: "Captivo Access: Ana (ana@vendor.com) opened a session to CRM at 2026-11-22 20:05 UTC. Recordings: https://acme/admin/recordings?q=CHG1" });
  });
  it("names an unrecorded native session and leaves the link out", () => {
    const n = noteText({ ...base, reason: "session_open native_ssh" });
    expect(noteText({ ...base, reason: "session_open native_ssh_recorded" })?.body).toContain("with their own SSH client at 2026-11-22 20:05 UTC. Recordings:");
    expect(n?.body).toContain("with their own SSH client (not recorded)");
    expect(n?.body).not.toContain("Recordings:");
    const t = noteText({ ...base, reason: "session_open native_tcp" });
    expect(t?.body).toContain("through a TCP tunnel (not recorded)");
    expect(t?.body).not.toContain("Recordings:");
  });
  it("says how long a session lasted", () => {
    expect(noteText({ ...base, reason: "session_close 42m" })?.body).toBe("Captivo Access: Ana (ana@vendor.com) closed the session to CRM at 2026-11-22 20:05 UTC after 42m.");
    expect(noteText({ ...base, reason: "denied" })).toBeNull();
  });
});
