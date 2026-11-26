import { describe, expect, it } from "vitest";
import { columnsFor, DEFAULT_PROFILE_SETTINGS, validateProfile, type ProfileSettings } from "./profiles";
import { compileCommandList, describeCommandList, parseEntries, validateCommandList } from "./command-lists";

const full: ProfileSettings = {
  recordSessions: true, keystrokeLogging: true, clipboardMode: "no_paste", watermark: true, fileTransferMode: "none",
  egressMode: "strict", egressHosts: ["sso.example.com"], requireModerator: true, passwordCheckout: true, checkoutMaxMinutes: 60, commandListId: "cl1",
};

describe("what a profile writes onto a resource", () => {
  it("writes only what a kind of resource uses", () => {
    expect(Object.keys(columnsFor(full, "TUNNEL"))).toEqual([]);
    expect(columnsFor(full, "GATEWAY")).toMatchObject({ recordSessions: true, keystrokeLogging: true, clipboardMode: "no_paste", requireModerator: true, commandListId: "cl1" });
    expect(columnsFor(full, "GATEWAY")).not.toHaveProperty("egressMode");
    expect(columnsFor(full, "ISOLATED")).toMatchObject({ egressMode: "strict", egressHosts: ["sso.example.com"], fileTransferMode: "none" });
    expect(columnsFor(full, "ISOLATED")).not.toHaveProperty("requireModerator");
    expect(columnsFor(full, "DATABASE")).toMatchObject({ recordSessions: true, passwordCheckout: true, checkoutMaxMinutes: 60, commandListId: "cl1" });
    expect(columnsFor(full, "DATABASE")).not.toHaveProperty("clipboardMode");
    expect(columnsFor(full, "KUBERNETES")).toMatchObject({ recordSessions: true, commandListId: "cl1" });
    expect(columnsFor(full, "KUBERNETES")).not.toHaveProperty("passwordCheckout");
  });

  it("never turns on check-out for a moderated remote desktop or SSH resource", () => {
    expect(columnsFor(full, "GATEWAY").passwordCheckout).toBe(false);
    expect(columnsFor({ ...full, requireModerator: false }, "GATEWAY").passwordCheckout).toBe(true);
  });

  it("leaves a setting at null so the resource follows the workspace Policy", () => {
    expect(columnsFor(DEFAULT_PROFILE_SETTINGS, "ISOLATED")).toMatchObject({ clipboardMode: null, watermark: null, fileTransferMode: null, egressMode: null });
  });
});

describe("validateProfile", () => {
  it("takes a name and fills the rest with the defaults", () => {
    const r = validateProfile({ name: " Vendors " });
    expect(r).toMatchObject({ ok: true, value: { name: "Vendors", recordSessions: false, clipboardMode: null, checkoutMaxMinutes: 240 } });
  });
  it("refuses what it cannot use", () => {
    expect(validateProfile({})).toEqual({ ok: false, error: "invalid_name" });
    expect(validateProfile({ name: "x".repeat(49) })).toEqual({ ok: false, error: "name_too_long" });
    expect(validateProfile({ name: "a", clipboardMode: "paste" })).toEqual({ ok: false, error: "invalid_clipboard" });
    expect(validateProfile({ name: "a", fileTransferMode: "x" })).toEqual({ ok: false, error: "invalid_file_transfer" });
    expect(validateProfile({ name: "a", egressMode: "x" })).toEqual({ ok: false, error: "invalid_egress" });
    expect(validateProfile({ name: "a", recordSessions: "yes" })).toEqual({ ok: false, error: "invalid_setting" });
    expect(validateProfile({ name: "a", checkoutMaxMinutes: 5 })).toEqual({ ok: false, error: "invalid_checkout_minutes" });
    expect(validateProfile({ name: "a", egressHosts: ["bad host"] })).toEqual({ ok: false, error: "invalid_egress_hosts" });
  });
  it("an edit keeps what it does not send", () => {
    const base = { ...full, name: "Vendors", description: null };
    const r = validateProfile({ clipboardMode: "none" }, base);
    expect(r).toMatchObject({ ok: true, value: { name: "Vendors", clipboardMode: "none", recordSessions: true, egressHosts: ["sso.example.com"] } });
    expect(validateProfile({ clipboardMode: null }, base)).toMatchObject({ ok: true, value: { clipboardMode: null } });
  });
  it("lower-cases and de-duplicates allowed hosts", () => {
    expect(validateProfile({ name: "a", egressHosts: ["SSO.Example.com", "sso.example.com", "*.okta.com"] })).toMatchObject({ ok: true, value: { egressHosts: ["sso.example.com", "*.okta.com"] } });
  });
});

describe("command lists", () => {
  it("parses entries one per line, trimmed and de-duplicated", () => {
    expect(parseEntries("ls\n  ls  \nSystemctl   status  *\n\n")).toEqual(["ls", "systemctl status *"].map((e) => (e === "systemctl status *" ? "Systemctl status *" : e)));
    expect(parseEntries(["a", "A", " b "])).toEqual(["a", "b"]);
    expect(parseEntries(5)).toBeNull();
    expect(parseEntries([1])).toBeNull();
  });
  it("validates a list", () => {
    expect(validateCommandList({ name: "Read only", mode: "allow", entries: "ls\ncat *" })).toMatchObject({ ok: true, value: { name: "Read only", mode: "allow", entries: ["ls", "cat *"] } });
    expect(validateCommandList({ mode: "allow", entries: "" })).toEqual({ ok: false, error: "invalid_name" });
    expect(validateCommandList({ name: "a", mode: "maybe", entries: "" })).toEqual({ ok: false, error: "invalid_mode" });
    expect(validateCommandList({ name: "a", mode: "deny", entries: 5 })).toEqual({ ok: false, error: "invalid_entries" });
    expect(validateCommandList({ name: "a", mode: "deny", entries: ["x".repeat(201)] })).toEqual({ ok: false, error: "entry_too_long" });
    expect(validateCommandList({ name: "a", mode: "deny", entries: Array.from({ length: 201 }, (_, i) => `c${i}`) })).toEqual({ ok: false, error: "too_many_entries" });
    expect(validateCommandList({ name: "a", mode: "deny", entries: ["a\u0000b"] })).toEqual({ ok: false, error: "entry_has_control" });
  });
  it("compiles a list for the data plane and describes it", () => {
    expect(compileCommandList({ name: "N", mode: "deny", entries: ["rm"] })).toEqual({ mode: "deny", entries: ["rm"], name: "N" });
    expect(compileCommandList(null)).toBeNull();
    expect(compileCommandList({ name: "N", mode: "weird", entries: [] })).toBeNull();
    expect(describeCommandList({ mode: "allow", entries: [] })).toBe("Allow list: nothing may run");
    expect(describeCommandList({ mode: "deny", entries: ["rm", "dd"] })).toBe("Deny list: 2 commands are blocked");
  });
});
