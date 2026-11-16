import { describe, expect, it } from "vitest";
import { effectiveEgress, egressReportOnlyUntil, parseEgressHosts, EGRESS_REPORT_ONLY_UNTIL } from "./egress";

const before = new Date("2026-10-01T00:00:00Z");
const after = new Date("2026-11-20T00:00:00Z");
const now = new Date("2026-11-18T00:00:00Z");

describe("isolated network rule", () => {
  it("always allows the resource's own host, besides the listed ones", () => {
    expect(effectiveEgress({ egressMode: "strict", egressHosts: ["*.okta.com"], createdAt: after, upstreamUrl: "https://CRM.corp.local:8443/x" }, now)).toEqual({
      mode: "strict",
      hosts: ["crm.corp.local", "*.okta.com"],
      reportOnly: false,
    });
  });

  it("a resource that inherits takes the Policy's mode", () => {
    const s = { egressMode: null, egressHosts: [], createdAt: after, upstreamUrl: "https://crm.local" };
    expect(effectiveEgress(s, now, "strict").mode).toBe("strict");
    expect(effectiveEgress({ ...s, egressMode: "open" }, now, "strict").mode).toBe("open");
  });

  it("defaults to the internet but not the internal network", () => {
    expect(effectiveEgress({ egressMode: null, egressHosts: [], createdAt: after, upstreamUrl: "http://10.0.0.20/" }, now)).toEqual({ mode: "internet", hosts: ["10.0.0.20"], reportOnly: false });
  });

  it("existing resources only record until the date, or until a mode is chosen", () => {
    const old = { egressMode: null, egressHosts: [], createdAt: before, upstreamUrl: "https://crm.local" };
    expect(effectiveEgress(old, now).reportOnly).toBe(true);
    expect(egressReportOnlyUntil(old, now)).toEqual(EGRESS_REPORT_ONLY_UNTIL);
    expect(effectiveEgress(old, EGRESS_REPORT_ONLY_UNTIL).reportOnly).toBe(false);
    expect(effectiveEgress({ ...old, egressMode: "internet" }, now).reportOnly).toBe(false);
  });

  it("parses hosts as admins type them", () => {
    expect(parseEgressHosts("sso.corp.local\n*.Okta.com, https://cdn.example.com/x  10.0.0.7")).toEqual(["sso.corp.local", "*.okta.com", "cdn.example.com", "10.0.0.7"]);
    expect(parseEgressHosts(["a.test", "a.test"])).toEqual(["a.test"]);
    expect(parseEgressHosts("bad host!")).toBeNull();
    expect(parseEgressHosts("*.*.x")).toBeNull();
    expect(parseEgressHosts(Array.from({ length: 51 }, (_, i) => `h${i}.test`))).toBeNull();
  });
});
