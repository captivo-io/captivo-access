import { describe, it, expect } from "vitest";
import { ipAllowed, validateAllowlist } from "./cidr";

describe("ipAllowed", () => {
  it("empty list = no restriction (allow anything)", () => {
    expect(ipAllowed("", "1.2.3.4")).toBe(true);
    expect(ipAllowed("   ", "203.0.113.9")).toBe(true);
  });

  it("matches IPv4 CIDRs and rejects outside", () => {
    const list = "10.0.0.0/8, 192.168.1.0/24";
    expect(ipAllowed(list, "10.5.6.7")).toBe(true);
    expect(ipAllowed(list, "192.168.1.42")).toBe(true);
    expect(ipAllowed(list, "192.168.2.42")).toBe(false);
    expect(ipAllowed(list, "8.8.8.8")).toBe(false);
  });

  it("matches a bare IP and comma/space/newline separators", () => {
    expect(ipAllowed("203.0.113.10\n198.51.100.0/24", "203.0.113.10")).toBe(true);
    expect(ipAllowed("203.0.113.10 198.51.100.0/24", "198.51.100.7")).toBe(true);
    expect(ipAllowed("203.0.113.10", "203.0.113.11")).toBe(false);
  });

  it("matches IPv6 CIDRs and IPv4-mapped IPv6", () => {
    expect(ipAllowed("2001:db8::/32", "2001:db8::1")).toBe(true);
    expect(ipAllowed("2001:db8::/32", "2001:dead::1")).toBe(false);
    // ::ffff:1.2.3.4 must match an IPv4 rule
    expect(ipAllowed("10.0.0.0/8", "::ffff:10.1.2.3")).toBe(true);
  });

  it("fails closed: an unparseable client IP is denied under an active list", () => {
    expect(ipAllowed("10.0.0.0/8", "not-an-ip")).toBe(false);
    expect(ipAllowed("10.0.0.0/8", "")).toBe(false);
  });

  it("an all-invalid list does not lock everyone out (behaves as no list)", () => {
    expect(ipAllowed("garbage, also-bad", "8.8.8.8")).toBe(true);
  });
});

describe("validateAllowlist", () => {
  it("returns [] for a valid list", () => {
    expect(validateAllowlist("10.0.0.0/8, 192.168.1.5, 2001:db8::/32")).toEqual([]);
  });
  it("reports invalid entries (bad IP, out-of-range prefix)", () => {
    expect(validateAllowlist("10.0.0.0/8, 999.1.1.1, 10.0.0.0/40")).toEqual(["999.1.1.1", "10.0.0.0/40"]);
  });
});

describe("an empty prefix", () => {
  it("is invalid, and never opens the list to everyone", () => {
    expect(validateAllowlist("1.2.3.4/")).toEqual(["1.2.3.4/"]);
    expect(ipAllowed("10.0.0.0/8, 1.2.3.4/", "203.0.113.9")).toBe(false);
  });
});
