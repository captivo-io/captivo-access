import { describe, it, expect } from "vitest";
import { parseGuacParams, resolveGuacParams, toGuacArgs } from "./guac-params";

describe("parseGuacParams", () => {
  it("keeps curated valid keys and drops the rest", () => {
    expect(parseGuacParams({
      serverLayout: "tr-tr-qwerty", colorDepth: 16, enableWallpaper: true,
      serverLayout2: "x", colorDepth99: 99, evil: "rm -rf",
    })).toEqual({ serverLayout: "tr-tr-qwerty", colorDepth: 16, enableWallpaper: true });
  });
  it("rejects an unknown layout and out-of-range colour depth", () => {
    expect(parseGuacParams({ serverLayout: "xx-yy-zzz", colorDepth: 99 })).toEqual({});
  });
  it("returns {} for non-objects", () => {
    expect(parseGuacParams(null)).toEqual({});
    expect(parseGuacParams("nope")).toEqual({});
  });
  it("keeps a valid absolute sftpRoot (hyphens/spaces ok), drops relative / control-char / over-long", () => {
    expect(parseGuacParams({ sftpRoot: "/srv/my-incoming dir" })).toEqual({ sftpRoot: "/srv/my-incoming dir" });
    expect(parseGuacParams({ sftpRoot: "relative/path" })).toEqual({});
    expect(parseGuacParams({ sftpRoot: "/bad\tnull" })).toEqual({});
    expect(parseGuacParams({ sftpRoot: "/" + "a".repeat(1100) })).toEqual({});
  });
});

describe("resolveGuacParams", () => {
  it("prefers the resource value, falls back to policy, leaves unset undefined", () => {
    const r = resolveGuacParams({ colorDepth: 24 }, { serverLayout: "de-de-qwertz", colorDepth: 8 });
    expect(r.colorDepth).toBe(24);               // resource wins
    expect(r.serverLayout).toBe("de-de-qwertz"); // policy fallback
    expect(r.enableWallpaper).toBeUndefined();   // neither set
  });
});

describe("toGuacArgs", () => {
  it("emits set/true params and maps clipboardMode", () => {
    expect(toGuacArgs({ serverLayout: "tr-tr-qwerty", colorDepth: 16, enableWallpaper: true, enableTheming: false }, "no_copy", "RDP"))
      .toEqual({ "server-layout": "tr-tr-qwerty", "color-depth": "16", "enable-wallpaper": "true", "disable-copy": "true" });
  });
  it("clipboardMode none blocks both; allow blocks neither", () => {
    expect(toGuacArgs({}, "none", "RDP")).toEqual({ "disable-copy": "true", "disable-paste": "true" });
    expect(toGuacArgs({}, "allow", "RDP")).toEqual({});
  });
  it("VNC clipboard: maps clipboardMode to disable-copy/paste, nothing else", () => {
    expect(toGuacArgs({}, "allow", "VNC")).toEqual({});
    expect(toGuacArgs({}, "no_copy", "VNC")).toEqual({ "disable-copy": "true" });
    expect(toGuacArgs({}, "no_paste", "VNC")).toEqual({ "disable-paste": "true" });
    expect(toGuacArgs({}, "none", "VNC")).toEqual({ "disable-copy": "true", "disable-paste": "true" });
  });
});

describe("toGuacArgs file transfer", () => {
  it("RDP on emits drive args; blocks map to disable-upload/download", () => {
    expect(toGuacArgs({ enableFileTransfer: true, blockUpload: true }, "allow", "RDP")).toEqual({
      "enable-drive": "true", "create-drive-path": "true", "drive-name": "Captivo", "disable-upload": "true",
    });
  });
  it("SSH on emits enable-sftp; blocks map to sftp-disable-*", () => {
    expect(toGuacArgs({ enableFileTransfer: true, blockDownload: true }, "allow", "SSH")).toEqual({
      "enable-sftp": "true", "sftp-root-directory": "/", "sftp-disable-download": "true",
    });
  });
  it("VNC emits no file-transfer args", () => {
    expect(toGuacArgs({ enableFileTransfer: true, blockUpload: true }, "allow", "VNC")).toEqual({});
  });
  it("off emits nothing", () => {
    expect(toGuacArgs({ blockUpload: true }, "allow", "RDP")).toEqual({});
  });
  it("SSH derives sftp-root-directory from the username's home", () => {
    expect(toGuacArgs({ enableFileTransfer: true }, "allow", "SSH", "deploy")).toEqual({
      "enable-sftp": "true", "sftp-root-directory": "/home/deploy",
    });
  });
  it("SSH root user maps to /root", () => {
    expect(toGuacArgs({ enableFileTransfer: true }, "allow", "SSH", "root")).toEqual({
      "enable-sftp": "true", "sftp-root-directory": "/root",
    });
  });
  it("SSH with no username falls back to /", () => {
    expect(toGuacArgs({ enableFileTransfer: true }, "allow", "SSH")).toEqual({
      "enable-sftp": "true", "sftp-root-directory": "/",
    });
  });
  it("SSH explicit sftpRoot override wins (including /)", () => {
    expect(toGuacArgs({ enableFileTransfer: true, sftpRoot: "/data/up" }, "allow", "SSH", "deploy")).toEqual({
      "enable-sftp": "true", "sftp-root-directory": "/data/up",
    });
    expect(toGuacArgs({ enableFileTransfer: true, sftpRoot: "/" }, "allow", "SSH", "deploy")).toEqual({
      "enable-sftp": "true", "sftp-root-directory": "/",
    });
  });
  it("SSH file transfer off emits no sftp args", () => {
    expect(toGuacArgs({ sftpRoot: "/data" }, "allow", "SSH", "deploy")).toEqual({});
  });
  it("RDP/VNC never emit sftp-root-directory", () => {
    expect(toGuacArgs({ enableFileTransfer: true, sftpRoot: "/data" }, "allow", "RDP", "deploy"))
      .not.toHaveProperty("sftp-root-directory");
    expect(toGuacArgs({ enableFileTransfer: true, sftpRoot: "/data" }, "allow", "VNC", "deploy")).toEqual({});
  });
  it("parseGuacParams keeps a valid rdpSecurity and drops an invalid one", () => {
    expect(parseGuacParams({ rdpSecurity: "nla" }).rdpSecurity).toBe("nla");
    expect(parseGuacParams({ rdpSecurity: "bogus" }).rdpSecurity).toBeUndefined();
  });
  it("toGuacArgs emits security for RDP when set, omits it otherwise", () => {
    expect(toGuacArgs({ rdpSecurity: "nla" }, "allow", "RDP")["security"]).toBe("nla");
    expect(toGuacArgs({ rdpSecurity: "nla" }, "allow", "SSH")["security"]).toBeUndefined();
    expect(toGuacArgs({}, "allow", "RDP")["security"]).toBeUndefined();
  });
});

describe("audio / printing / terminal params", () => {
  it("parses and bounds the new keys", () => {
    expect(parseGuacParams({ disableAudio: true, enablePrinting: true, terminalFontSize: "14", terminalColorScheme: "green-black", terminalScrollback: 5000 }))
      .toEqual({ disableAudio: true, enablePrinting: true, terminalFontSize: 14, terminalColorScheme: "green-black", terminalScrollback: 5000 });
    expect(parseGuacParams({ terminalFontSize: 4, terminalColorScheme: "neon", terminalScrollback: 10 })).toEqual({});
  });
  it("emits guacd args per protocol", () => {
    const rdp = toGuacArgs({ disableAudio: true, enablePrinting: true, terminalFontSize: 14 }, "allow", "RDP");
    expect(rdp["disable-audio"]).toBe("true");
    expect(rdp["enable-printing"]).toBe("true");
    expect(rdp["printer-name"]).toBe("Captivo Printer");
    expect(rdp["font-size"]).toBeUndefined();
    const ssh = toGuacArgs({ disableAudio: true, enablePrinting: true, terminalFontSize: 14, terminalColorScheme: "green-black", terminalScrollback: 5000 }, "allow", "SSH", "root");
    expect(ssh["font-size"]).toBe("14");
    expect(ssh["color-scheme"]).toBe("green-black");
    expect(ssh["scrollback"]).toBe("5000");
    expect(ssh["disable-audio"]).toBeUndefined();
    expect(ssh["enable-printing"]).toBeUndefined();
  });
});
