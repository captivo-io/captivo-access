import { describe, expect, it } from "vitest";
import { datadogSiteOf, parseDestination, secretRequired, splunkHecUrl } from "./config";

const syslog = { kind: "syslog", name: "QRadar", transport: "tls", host: "siem.corp.local", port: "6514", connectorId: "c1", format: "cef", facility: 16 };

describe("parseDestination", () => {
  it("takes a syslog destination", () => {
    const r = parseDestination(syslog, { cloud: true });
    expect(r.ok && r.data).toMatchObject({ kind: "syslog", transport: "tls", host: "siem.corp.local", port: 6514, framing: "newline", format: "cef", sendRequests: false, sendDenied: true });
  });

  it("refuses what is not a host and port", () => {
    for (const host of ["http://siem", "siem corp", "siem/x", ""]) {
      expect(parseDestination({ ...syslog, host }, { cloud: true })).toEqual({ ok: false, error: "invalid_host" });
    }
    expect(parseDestination({ ...syslog, port: "70000" }, { cloud: true })).toEqual({ ok: false, error: "invalid_port" });
    expect(parseDestination({ ...syslog, connectorId: "" }, { cloud: true })).toEqual({ ok: false, error: "connector_required" });
    expect(parseDestination({ ...syslog, caPem: "nope" }, { cloud: true })).toEqual({ ok: false, error: "invalid_ca" });
  });

  it("drops what the transport can't use", () => {
    const r = parseDestination({ ...syslog, transport: "udp", port: "", framing: "octet", caPem: "-----BEGIN CERTIFICATE-----x" }, { cloud: true });
    expect(r.ok && r.data).toMatchObject({ port: 514, framing: null, caPem: null });
    const same = parseDestination({ ...syslog, fallbackConnectorId: "c1" }, { cloud: true });
    expect(same.ok && same.data.fallbackConnectorId).toBeNull();
  });

  it("wants HTTPS for cloud destinations on Cloud", () => {
    expect(parseDestination({ kind: "https", name: "x", url: "http://logs.example.com/in" }, { cloud: true })).toEqual({ ok: false, error: "https_required" });
    expect(parseDestination({ kind: "https", name: "x", url: "http://10.0.0.5/in" }, { cloud: false }).ok).toBe(true);
    expect(parseDestination({ kind: "https", name: "x", url: "https://u:p@logs.example.com" }, { cloud: true })).toEqual({ ok: false, error: "invalid_url" });
    expect(parseDestination({ kind: "https", name: "x", url: "https://logs.example.com", headerName: "Bad Header" }, { cloud: true })).toEqual({ ok: false, error: "invalid_header" });
  });

  it("builds the Splunk and Datadog addresses", () => {
    const s = parseDestination({ kind: "splunk_hec", name: "Splunk", url: "https://http-inputs-acme.splunkcloud.com", secret: " tok " }, { cloud: true });
    expect(s.ok && s.data.url).toBe("https://http-inputs-acme.splunkcloud.com/services/collector/event");
    expect(s.ok && s.secret).toBe("tok");
    expect(splunkHecUrl("https://s:8088/services/collector")).toBe("https://s:8088/services/collector");
    const d = parseDestination({ kind: "datadog", name: "DD", datadogSite: "datadoghq.eu" }, { cloud: true });
    expect(d.ok && d.data.url).toBe("https://http-intake.logs.datadoghq.eu/api/v2/logs");
    expect(datadogSiteOf("https://http-intake.logs.datadoghq.eu/api/v2/logs")).toBe("datadoghq.eu");
    expect(parseDestination({ kind: "datadog", name: "DD", datadogSite: "evil.com" }, { cloud: true })).toEqual({ ok: false, error: "invalid_site" });
  });

  it("knows which kinds need a secret", () => {
    expect(secretRequired({ kind: "splunk_hec", headerName: null })).toBe(true);
    expect(secretRequired({ kind: "https", headerName: null })).toBe(false);
    expect(secretRequired({ kind: "https", headerName: "Authorization" })).toBe(true);
    expect(secretRequired({ kind: "syslog", headerName: null })).toBe(false);
  });
});
