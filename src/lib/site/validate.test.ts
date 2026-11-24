import { describe, it, expect } from "vitest";
import { validateSiteInput } from "./validate";

const base = { nativeGateway: true, requireSecret: true, recordingEnabled: true, isolationEnabled: true };
const selfHost = { ...base, hostSuffix: ".access.example.com" };
const cloud = { ...base, hostSuffix: ".acme.cloud.captivo.io" };

describe("validateSiteInput", () => {
  it("database: takes MySQL with no default database, and no allowed-database list", () => {
    const body = { accessMode: "DATABASE", connectorId: "c", name: "n", engine: "mysql", targetHost: "10.0.0.7", targetPort: 3306, username: "app", secret: "pw", database: "", databases: "crm, hr" };
    const r = validateSiteInput(body, base);
    expect(r).toMatchObject({ ok: true, engine: "MYSQL", dbParams: { database: "", databases: [] } });
    expect(validateSiteInput({ ...body, engine: "POSTGRES" }, base)).toMatchObject({ ok: false, error: "invalid_database" });
    expect(validateSiteInput({ ...body, engine: "ORACLE" }, base)).toMatchObject({ ok: false, error: "invalid_engine" });
  });
  it("tunnel: a host and a port, no account; needs the gateway", () => {
    const body = { accessMode: "TUNNEL", connectorId: "c", name: "Redis", targetHost: "redis.corp", targetPort: 6379 };
    expect(validateSiteInput(body, base)).toEqual({ ok: true, mode: "TUNNEL", connectorId: "c", name: "Redis", description: null, targetHost: "redis.corp", targetPort: 6379 });
    expect(validateSiteInput({ ...body, targetPort: 0 }, base)).toMatchObject({ ok: false, error: "invalid_port" });
    expect(validateSiteInput({ ...body, targetHost: "http://redis" }, base)).toMatchObject({ ok: false, error: "tunnel_target_required" });
    expect(validateSiteInput(body, { ...base, nativeGateway: false })).toMatchObject({ ok: false, error: "native_gateway_disabled" });
  });
  it("kubernetes: the API server, a service account and its token, the rules", () => {
    const body = { accessMode: "KUBERNETES", connectorId: "c", name: "Prod", apiServer: "https://10.0.0.5:6443", secret: "tok", namespaces: "web", readOnly: true, recordSessions: true, keystrokeLogging: true };
    expect(validateSiteInput(body, base)).toMatchObject({
      ok: true, mode: "KUBERNETES", targetHost: "10.0.0.5", targetPort: 6443, username: "captivo-access", recordSessions: true,
      kubeParams: { identity: "impersonate", namespaces: ["web"], readOnly: true, portForward: false },
    });
    expect(validateSiteInput({ ...body, apiServer: "10.0.0.5:6443/x" }, base)).toMatchObject({ ok: false, error: "invalid_api_server" });
    expect(validateSiteInput({ ...body, kubeGroups: "system:masters" }, base)).toMatchObject({ ok: false, error: "invalid_kube_group" });
    expect(validateSiteInput({ ...body, secret: undefined }, base)).toMatchObject({ ok: false, error: "kube_token_required" });
    expect(validateSiteInput(body, { ...base, nativeGateway: false })).toMatchObject({ ok: false, error: "native_gateway_disabled" });
  });
  it("self-host: appends .<accessDomain> to a bare label", () => {
    const r = validateSiteInput({ accessMode: "TRANSPARENT", connectorId: "c", name: "n", hostname: "WIKI", upstreamUrl: "http://10.0.0.5:80" }, selfHost);
    expect(r).toMatchObject({ ok: true, hostname: "wiki.access.example.com" });
  });
  it("cloud: nests the site under the tenant subdomain (per-tenant namespace)", () => {
    const r = validateSiteInput({ accessMode: "TRANSPARENT", connectorId: "c", name: "n", hostname: "wiki", upstreamUrl: "http://10.0.0.5:80" }, cloud);
    expect(r).toMatchObject({ ok: true, hostname: "wiki.acme.cloud.captivo.io" });
  });
  it("rejects a non-label (contains a dot) when a suffix is set", () => {
    const r = validateSiteInput({ accessMode: "TRANSPARENT", connectorId: "c", name: "n", hostname: "a.b", upstreamUrl: "http://10.0.0.5:80" }, selfHost);
    expect(r).toMatchObject({ ok: false, error: "invalid_hostname" });
  });
  it("without a suffix, uses the value as-is (dev/misconfig)", () => {
    const r = validateSiteInput({ accessMode: "TRANSPARENT", connectorId: "c", name: "n", hostname: "app.x.io", upstreamUrl: "http://10.0.0.5:80" }, base);
    expect(r).toMatchObject({ ok: true, hostname: "app.x.io" });
  });
  it("custom domain: uses the entered FQDN verbatim (no suffix)", () => {
    const r = validateSiteInput({ accessMode: "TRANSPARENT", connectorId: "c", name: "n", customDomain: true, hostname: "Portal.ACME.com", upstreamUrl: "http://10.0.0.5:80" }, cloud);
    expect(r).toMatchObject({ ok: true, hostname: "portal.acme.com", customDomain: true });
  });
  it("custom domain: rejects a non-FQDN", () => {
    const r = validateSiteInput({ accessMode: "TRANSPARENT", connectorId: "c", name: "n", customDomain: true, hostname: "notadomain", upstreamUrl: "http://10.0.0.5:80" }, cloud);
    expect(r).toMatchObject({ ok: false, error: "invalid_hostname" });
  });
  it("managed (default) still appends the suffix", () => {
    const r = validateSiteInput({ accessMode: "TRANSPARENT", connectorId: "c", name: "n", hostname: "wiki", upstreamUrl: "http://10.0.0.5:80" }, cloud);
    expect(r).toMatchObject({ ok: true, hostname: "wiki.acme.cloud.captivo.io", customDomain: false });
  });
  it("maps inherit clipboardMode to null (isolated)", () => {
    const r = validateSiteInput({ accessMode: "ISOLATED", connectorId: "c1", name: "n", upstreamUrl: "https://x.example", clipboardMode: "inherit" }, base);
    expect(r.ok).toBe(true);
    if (r.ok && r.mode === "ISOLATED") expect(r.clipboardMode).toBeNull();
  });
  it("passes a concrete clipboardMode through (isolated)", () => {
    const r = validateSiteInput({ accessMode: "ISOLATED", connectorId: "c1", name: "n", upstreamUrl: "https://x.example", clipboardMode: "no_copy" }, base);
    if (r.ok && r.mode === "ISOLATED") expect(r.clipboardMode).toBe("no_copy");
  });
  it("maps an unknown clipboardMode to null (transparent)", () => {
    const r = validateSiteInput({ accessMode: "TRANSPARENT", connectorId: "c1", name: "n", hostname: "h.example", upstreamUrl: "https://x.example", clipboardMode: "garbage" }, base);
    if (r.ok && r.mode === "TRANSPARENT") expect(r.clipboardMode).toBeNull();
  });
  it("web app needs hostname + upstream", () => {
    const r = validateSiteInput({ accessMode: "TRANSPARENT", connectorId: "c", name: "n", hostname: "", upstreamUrl: "" }, base);
    expect(r).toMatchObject({ ok: false });
  });
  it("web app ok returns normalized fields", () => {
    const r = validateSiteInput({ accessMode: "TRANSPARENT", connectorId: "c", name: "n", hostname: "APP.x.io", upstreamUrl: "http://10.0.0.5:80", recordSessions: true }, base);
    expect(r).toMatchObject({ ok: true, mode: "TRANSPARENT", hostname: "app.x.io", recordSessions: true });
  });
  it("web app keeps its file transfer and watermark choices; inherit is null", () => {
    const web = { accessMode: "TRANSPARENT", connectorId: "c", name: "n", hostname: "a.x.io", upstreamUrl: "http://10.0.0.5" };
    expect(validateSiteInput({ ...web, fileTransferMode: "no_download", watermark: true }, base)).toMatchObject({ ok: true, fileTransferMode: "no_download", watermark: true });
    expect(validateSiteInput({ ...web, fileTransferMode: "inherit", watermark: "inherit" }, base)).toMatchObject({ ok: true, fileTransferMode: null, watermark: null });
    expect(validateSiteInput({ ...web, fileTransferMode: "bogus", watermark: false }, base)).toMatchObject({ ok: true, fileTransferMode: null, watermark: false });
  });
  it("remote desktop keeps its watermark choice", () => {
    const rd = { accessMode: "GATEWAY", connectorId: "c", name: "n", protocol: "SSH", targetHost: "10.0.0.5", targetPort: 22, username: "u", secret: "pw" };
    expect(validateSiteInput({ ...rd, watermark: true }, base)).toMatchObject({ ok: true, watermark: true });
    expect(validateSiteInput({ ...rd, watermark: "inherit" }, base)).toMatchObject({ ok: true, watermark: null });
  });
  it("web app rejects a non-http upstream", () => {
    const r = validateSiteInput({ accessMode: "TRANSPARENT", connectorId: "c", name: "n", hostname: "a.x", upstreamUrl: "ftp://x" }, base);
    expect(r).toMatchObject({ ok: false, error: "invalid_upstream_url" });
  });
  it("remote desktop needs protocol/host/port/username/secret", () => {
    const r = validateSiteInput({ accessMode: "GATEWAY", connectorId: "c", name: "n", protocol: "RDP", targetHost: "", targetPort: 0, username: "", secret: "" }, base);
    expect(r).toMatchObject({ ok: false });
  });
  it("remote desktop ok returns the target", () => {
    const r = validateSiteInput({ accessMode: "GATEWAY", connectorId: "c", name: "n", protocol: "rdp", targetHost: "10.0.0.5", targetPort: 3389, username: "adm", secret: "pw" }, base);
    expect(r).toMatchObject({ ok: true, mode: "GATEWAY", protocol: "RDP", targetHost: "10.0.0.5", targetPort: 3389, username: "adm", secret: { secret: "pw" } });
  });
  it("keeps native RDP and native SSH for their own protocols", () => {
    const rd = { accessMode: "GATEWAY", connectorId: "c", name: "n", targetHost: "10.0.0.5", targetPort: 3389, username: "u", secret: "pw", nativeRdp: true };
    expect(validateSiteInput({ ...rd, protocol: "RDP" }, base)).toMatchObject({ ok: true, nativeRdp: true });
    expect(validateSiteInput({ ...rd, protocol: "VNC" }, base)).toMatchObject({ ok: true, nativeRdp: false });
    expect(validateSiteInput({ ...rd, protocol: "RDP", nativeRdp: "yes" }, base)).toMatchObject({ ok: true, nativeRdp: false });
    const sh = { ...rd, protocol: "SSH", targetPort: 22, nativeSsh: true };
    expect(validateSiteInput(sh, base)).toMatchObject({ ok: true, nativeSsh: true, nativeRdp: false });
    expect(validateSiteInput({ ...sh, protocol: "RDP" }, base)).toMatchObject({ ok: true, nativeSsh: false });
  });
  it("remote desktop takes a password sealed in the browser instead", () => {
    const r = validateSiteInput({ accessMode: "GATEWAY", connectorId: "c", name: "n", protocol: "rdp", targetHost: "h", targetPort: 3389, username: "u", sealedSecret: "cv1:x", sealedTo: "k" }, base);
    expect(r).toMatchObject({ ok: true, secret: { sealedSecret: "cv1:x", sealedTo: "k" } });
  });
  it("remote desktop carries recordSessions (native gateway recording)", () => {
    const on = validateSiteInput({ accessMode: "GATEWAY", connectorId: "c", name: "n", protocol: "RDP", targetHost: "h", targetPort: 3389, username: "u", secret: "s", recordSessions: true }, base);
    expect(on).toMatchObject({ ok: true, mode: "GATEWAY", recordSessions: true });
    const off = validateSiteInput({ accessMode: "GATEWAY", connectorId: "c", name: "n", protocol: "RDP", targetHost: "h", targetPort: 3389, username: "u", secret: "s", recordSessions: true }, { ...base, recordingEnabled: false });
    expect(off).toMatchObject({ ok: true, mode: "GATEWAY", recordSessions: false });
  });
  it("remote desktop rejected when native gateway is off", () => {
    const r = validateSiteInput({ accessMode: "GATEWAY", connectorId: "c", name: "n", protocol: "RDP", targetHost: "h", targetPort: 3389, username: "u", secret: "s" }, { ...base, nativeGateway: false });
    expect(r).toMatchObject({ ok: false, error: "native_gateway_disabled" });
  });
  it("remote desktop update may omit the secret (requireSecret false)", () => {
    const r = validateSiteInput({ accessMode: "GATEWAY", connectorId: "c", name: "n", protocol: "SSH", targetHost: "h", targetPort: 22, username: "u", secret: "" }, { ...base, requireSecret: false });
    expect(r).toMatchObject({ ok: true, secret: null });
  });
  it("ISOLATED: requires upstreamUrl, no hostname/vault, gated", () => {
    const b = { connectorId: "c1", name: "Wiki", accessMode: "ISOLATED", upstreamUrl: "https://wiki.internal" };
    expect(validateSiteInput(b, { ...base, isolationEnabled: false }))
      .toEqual({ ok: false, error: "isolation_disabled" });
    expect(validateSiteInput(b, { ...base, isolationEnabled: true }))
      .toMatchObject({ ok: true, mode: "ISOLATED", connectorId: "c1", name: "Wiki", upstreamUrl: "https://wiki.internal" });
    expect(validateSiteInput({ ...b, upstreamUrl: "ftp://x" }, { ...base, isolationEnabled: true }))
      .toEqual({ ok: false, error: "invalid_upstream_url" });
    expect(validateSiteInput({ ...b, upstreamUrl: "" }, { ...base, isolationEnabled: true }))
      .toEqual({ ok: false, error: "isolated_url_required" });
    expect(validateSiteInput({ ...b }, { ...base, isolationEnabled: true }))
      .toMatchObject({ ok: true, mode: "ISOLATED" });
  });
  it("ISOLATED: insecureSkipVerify defaults false, true when set", () => {
    const b = { connectorId: "c1", name: "Wiki", accessMode: "ISOLATED", upstreamUrl: "https://wiki.internal" };
    expect(validateSiteInput(b, base)).toMatchObject({ ok: true, insecureSkipVerify: false });
    expect(validateSiteInput({ ...b, insecureSkipVerify: true }, base)).toMatchObject({ ok: true, insecureSkipVerify: true });
  });
  it("ISOLATED: fileTransferMode inherits the Policy unless set, accepts valid, normalizes invalid", () => {
    const b = { connectorId: "c1", name: "Wiki", accessMode: "ISOLATED", upstreamUrl: "https://wiki.internal" };
    expect(validateSiteInput(b, base)).toMatchObject({ ok: true, mode: "ISOLATED", fileTransferMode: null });
    expect(validateSiteInput({ ...b, fileTransferMode: "inherit" }, base)).toMatchObject({ ok: true, fileTransferMode: null });
    expect(validateSiteInput({ ...b, fileTransferMode: "none" }, base)).toMatchObject({ ok: true, fileTransferMode: "none" });
    expect(validateSiteInput({ ...b, fileTransferMode: "no_download" }, base)).toMatchObject({ ok: true, fileTransferMode: "no_download" });
    expect(validateSiteInput({ ...b, fileTransferMode: "allow" }, base)).toMatchObject({ ok: true, fileTransferMode: "allow" });
    expect(validateSiteInput({ ...b, fileTransferMode: "bogus" }, base)).toMatchObject({ ok: true, fileTransferMode: null });
  });
});

describe("isolated network rule input", () => {
  const iso = { accessMode: "ISOLATED", connectorId: "c", name: "n", upstreamUrl: "https://crm.local" };
  const opts = { nativeGateway: true, requireSecret: false, recordingEnabled: true, isolationEnabled: true };
  it("keeps the rule unchanged when not sent, takes it when sent", () => {
    expect(validateSiteInput(iso, opts)).toMatchObject({ ok: true, egressMode: undefined, egressHosts: undefined });
    expect(validateSiteInput({ ...iso, egressMode: "strict", egressHosts: "sso.local\n*.okta.com" }, opts)).toMatchObject({ ok: true, egressMode: "strict", egressHosts: ["sso.local", "*.okta.com"] });
    expect(validateSiteInput({ ...iso, egressMode: null }, opts)).toMatchObject({ ok: true, egressMode: undefined });
    expect(validateSiteInput({ ...iso, egressMode: "inherit" }, opts)).toMatchObject({ ok: true, egressMode: null });
  });
  it("refuses an unknown mode or a malformed host", () => {
    expect(validateSiteInput({ ...iso, egressMode: "lan" }, opts)).toMatchObject({ ok: false, error: "invalid_egress_mode" });
    expect(validateSiteInput({ ...iso, egressHosts: "bad_host!" }, opts)).toMatchObject({ ok: false, error: "invalid_egress_hosts" });
  });
});
