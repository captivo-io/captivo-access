import { describe, expect, it } from "vitest";
import { linuxInstallCommand, windowsInstallCommand } from "./standalone";

const v = { code: "abc123DEF456ghi7", managerUrl: "https://acme.cloud.captivo.io", tunnelUrl: "wss://connect.cloud.captivo.io", version: "2.65.0" };

describe("program install commands", () => {
  it("download the release for this version and check it before installing", () => {
    const win = windowsInstallCommand(v);
    expect(win).toContain("https://github.com/captivo-io/captivo-access/releases/download/v2.65.0/captivo-connector_2.65.0_windows_amd64.zip");
    expect(win).toContain("SHA256SUMS");
    expect(win.indexOf("Get-FileHash")).toBeLessThan(win.indexOf("service install"));
    expect(win).toContain("--pair-code 'abc123DEF456ghi7'");
    const lin = linuxInstallCommand(v);
    expect(lin).toContain("captivo-connector_2.65.0_linux_$a.tar.gz");
    expect(lin.indexOf("sha256sum -c")).toBeLessThan(lin.indexOf("service install"));
    expect(lin).toContain("--manager-url 'https://acme.cloud.captivo.io'");
  });
  it("quote what they are given", () => {
    const odd = { ...v, code: "it's" };
    expect(windowsInstallCommand(odd)).toContain("'it''s'");
    expect(linuxInstallCommand(odd)).toContain(`'it'\\''s'`);
  });
});
