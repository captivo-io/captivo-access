import { describe, it, expect } from "vitest";
import { allowlistEntryValid, checkAllowlist } from "./allowlist";
import { validateAllowlist } from "@/lib/net/cidr";

const SAMPLES = [
  "10.0.0.0/8", "192.168.1.10", "0.0.0.0/0", "255.255.255.255/32", "10.0.0.300", "10.0.0.0/33", "10.0.0", "10.0.0.0/-1",
  "10.0.0.0/8/9", "01.2.3.4", "1.2.3.4/", "a.b.c.d",
  "2001:db8::/32", "::1", "::", "fe80::1/64", "2001:db8::/129", "2001:db8:::1", "1:2:3:4:5:6:7:8", "1:2:3:4:5:6:7:8:9",
  "::ffff:10.0.0.1", "::ffff:10.0.0.300", "gggg::1", "1::2::3", "2001:db8::/48", "12345::1",
];

describe("vendor IP allowlist check", () => {
  it("catches what the old check let through", () => {
    expect(allowlistEntryValid("10.0.0.300")).toBe(false);
    expect(allowlistEntryValid("10.0.0.0/33")).toBe(false);
    expect(allowlistEntryValid("2001:db8::/129")).toBe(false);
    expect(allowlistEntryValid("10.0.0.0/8")).toBe(true);
    expect(allowlistEntryValid("2001:db8::/32")).toBe(true);
  });
  it("agrees with the server on every sample", () => {
    for (const s of SAMPLES) {
      expect(allowlistEntryValid(s), s).toBe(validateAllowlist(s).length === 0);
    }
  });
  it("splits on commas and whitespace", () => {
    expect(checkAllowlist("10.0.0.0/8, 1.2.3.4\n10.0.0.300").invalid).toEqual(["10.0.0.300"]);
  });
});
