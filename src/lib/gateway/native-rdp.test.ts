import { describe, expect, it } from "vitest";
import { blockedChannels, nativeRdpBlock, nativeRdpMode, nativeRedirection, rdpFile, rdpFileName, redirectFlags } from "./native-rdp";

const base = { accessMode: "GATEWAY", nativeRdp: true, protocol: "RDP", recordingRequired: false, connectorVersion: "2.39.0" };

describe("nativeRdpBlock", () => {
  it("allows an RDP resource that asks for it while recording is not required", () => {
    expect(nativeRdpBlock(base)).toBeNull();
    expect(nativeRdpBlock({ ...base, connectorVersion: "2.40.1" })).toBeNull();
    expect(nativeRdpBlock({ ...base, connectorVersion: "dev" })).toBeNull();
  });
  it("says why not", () => {
    expect(nativeRdpBlock({ ...base, protocol: "SSH" })).toBe("not_rdp");
    expect(nativeRdpBlock({ ...base, accessMode: "ISOLATED" })).toBe("not_rdp");
    expect(nativeRdpBlock({ ...base, nativeRdp: false })).toBe("off");
    expect(nativeRdpBlock({ ...base, recordingRequired: true })).toBe("connector_outdated");
    expect(nativeRdpBlock({ ...base, connectorVersion: "2.35.1" })).toBe("connector_outdated");
  });
});

describe("nativeRdpMode", () => {
  it("records on a recorded resource once the connector can sign in", () => {
    expect(nativeRdpMode({ ...base, recorded: true, connectorVersion: "2.52.0" })).toBe("recorded");
    expect(nativeRdpMode({ ...base, recordingRequired: true, connectorVersion: "2.52.0" })).toBe("recorded");
    // An older connector keeps the direct, unrecorded way, unless the Policy requires recording.
    expect(nativeRdpMode({ ...base, recorded: true, connectorVersion: "2.51.0" })).toBe("direct");
    expect(nativeRdpMode({ ...base, connectorVersion: "2.52.0" })).toBe("direct");
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

describe("recorded sessions", () => {
  it("names the console as the computer and asks for no credentials", () => {
    const f = rdpFile({ gatewayHost: "acme.cloud.captivo.io", targetHost: "10.0.0.5", targetPort: 3389, token: "cr1.x", redirection: { clipboard: true, drives: false, printers: false }, recorded: true });
    expect(f).toContain("full address:s:acme.cloud.captivo.io\r\n");
    expect(f).toContain("enablecredsspsupport:i:0");
    expect(f).toContain("prompt for credentials:i:0");
    expect(f).not.toContain("10.0.0.5");
  });
  it("asks for no persistent bitmap cache, which the recording never sees", () => {
    const rec = rdpFile({ gatewayHost: "acme.cloud.captivo.io", targetHost: "10.0.0.5", targetPort: 3389, token: "cr1.x", redirection: { clipboard: true, drives: false, printers: false }, recorded: true });
    const plain = rdpFile({ gatewayHost: "acme.cloud.captivo.io", targetHost: "10.0.0.5", targetPort: 3389, token: "cr1.x", redirection: { clipboard: true, drives: false, printers: false } });
    expect(rec).toContain("bitmapcachepersistenable:i:0\r\n");
    expect(plain).not.toContain("bitmapcachepersistenable");
  });
  it("keeps the clipboard and device channels closed as the rules say", () => {
    expect(blockedChannels({ clipboard: false, drives: false, printers: false })).toEqual(["cliprdr", "rdpdr"]);
    expect(blockedChannels({ clipboard: true, drives: false, printers: true })).toEqual([]);
  });
});
