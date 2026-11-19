import { describe, expect, it } from "vitest";
import { nativeRdpBlock, nativeRedirection, rdpFile, rdpFileName, redirectFlags } from "./native-rdp";

const base = { accessMode: "GATEWAY", nativeRdp: true, protocol: "RDP", recorded: false, connectorVersion: "2.39.0" };

describe("nativeRdpBlock", () => {
  it("allows an RDP resource that asks for it and is not recorded", () => {
    expect(nativeRdpBlock(base)).toBeNull();
    expect(nativeRdpBlock({ ...base, connectorVersion: "2.40.1" })).toBeNull();
    expect(nativeRdpBlock({ ...base, connectorVersion: "dev" })).toBeNull();
  });
  it("says why not", () => {
    expect(nativeRdpBlock({ ...base, protocol: "SSH" })).toBe("not_rdp");
    expect(nativeRdpBlock({ ...base, accessMode: "ISOLATED" })).toBe("not_rdp");
    expect(nativeRdpBlock({ ...base, nativeRdp: false })).toBe("off");
    expect(nativeRdpBlock({ ...base, recorded: true })).toBe("recorded");
    expect(nativeRdpBlock({ ...base, connectorVersion: "2.35.1" })).toBe("connector_outdated");
  });
});

describe("redirection", () => {
  it("opens a channel only when both directions are allowed", () => {
    expect(nativeRedirection("allow", { enableFileTransfer: true, blockUpload: false, blockDownload: false, enablePrinting: true }))
      .toEqual({ clipboard: true, drives: true, printers: true });
    expect(nativeRedirection("no_copy", { enableFileTransfer: true, blockUpload: true }))
      .toEqual({ clipboard: false, drives: false, printers: false });
  });
  it("always switches off ports and plug-and-play devices", () => {
    expect(redirectFlags({ clipboard: true, drives: true, printers: true })).toBe(0x14);
    expect(redirectFlags({ clipboard: false, drives: false, printers: false })).toBe(0x1f);
  });
});

describe("rdpFile", () => {
  it("points the client at the gateway with the ticket", () => {
    const f = rdpFile({ gatewayHost: "acme.cloud.captivo.io", targetHost: "10.0.0.5", targetPort: 3390, token: "cr1.a.b", redirection: { clipboard: false, drives: false, printers: false } });
    const lines = f.split("\r\n");
    expect(lines).toContain("full address:s:10.0.0.5:3390");
    expect(lines).toContain("gatewayhostname:s:acme.cloud.captivo.io");
    expect(lines).toContain("gatewaycredentialssource:i:5");
    expect(lines).toContain("gatewayaccesstoken:s:cr1.a.b");
    expect(lines).toContain("redirectclipboard:i:0");
    expect(lines).toContain("drivestoredirect:s:");
    expect(f.endsWith("\r\n")).toBe(true);
  });
  it("leaves the default port out and keeps every value on one line", () => {
    const f = rdpFile({ gatewayHost: "gw\r\nusername:s:x", targetHost: "dc", targetPort: 3389, token: "t", redirection: { clipboard: true, drives: true, printers: false } });
    expect(f).toContain("full address:s:dc\r\n");
    expect(f).toContain("gatewayhostname:s:gwusername:s:x\r\n");
    expect(f).toContain("drivestoredirect:s:*");
  });
});

describe("rdpFileName", () => {
  it("makes a safe file name", () => {
    expect(rdpFileName("DC (main) / İstanbul")).toBe("DC-main-Istanbul.rdp");
    expect(rdpFileName("***")).toBe("remote-desktop.rdp");
  });
});
