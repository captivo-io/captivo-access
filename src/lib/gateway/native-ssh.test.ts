import { afterEach, describe, expect, it } from "vitest";
import { nativeSshBlock, nativeSshMode, sshCommand, sshPublicHost, sshPublicPort } from "./native-ssh";
import { recordedHostKeyAlias } from "./native-ssh-command";
import { newSshTicketCode } from "./native-ssh-ticket";

const base = { accessMode: "GATEWAY", nativeSsh: true, protocol: "SSH", recordingRequired: false, connectorVersion: "2.42.0" };

describe("nativeSshBlock", () => {
  it("allows an SSH resource that asks for it while recording is not required", () => {
    expect(nativeSshBlock(base)).toBeNull();
    expect(nativeSshBlock({ ...base, protocol: "ssh", connectorVersion: "dev" })).toBeNull();
  });
  it("says why not", () => {
    expect(nativeSshBlock({ ...base, protocol: "RDP" })).toBe("not_ssh");
    expect(nativeSshBlock({ ...base, accessMode: "ISOLATED" })).toBe("not_ssh");
    expect(nativeSshBlock({ ...base, nativeSsh: false })).toBe("off");
    expect(nativeSshBlock({ ...base, recordingRequired: true })).toBe("connector_outdated");
    expect(nativeSshBlock({ ...base, connectorVersion: "2.38.4" })).toBe("connector_outdated");
  });
});

describe("nativeSshMode", () => {
  it("records on a recorded resource whose connector signs in (2.49.0)", () => {
    expect(nativeSshMode({ ...base, recorded: true, connectorVersion: "2.49.0" })).toBe("recorded");
    expect(nativeSshMode({ ...base, recordingRequired: true, connectorVersion: "2.49.1" })).toBe("recorded");
    expect(nativeSshMode({ ...base, connectorVersion: "2.49.0" })).toBe("direct");
  });
  it("stays direct and unrecorded on an older connector, unless the Policy requires recording", () => {
    expect(nativeSshMode({ ...base, recorded: true, connectorVersion: "2.48.0" })).toBe("direct");
    expect(nativeSshMode({ ...base, recorded: true, recordingRequired: true, connectorVersion: "2.48.0" })).toBe("connector_outdated");
  });
});

describe("sshCommand", () => {
  const o = { code: "k7f3q9wz2m4x", jumpHost: "acme.cloud.captivo.io", jumpPort: 2222, targetHost: "10.0.0.5", targetPort: 22, user: "deploy" };
  it("puts the ticket on the jump hop and the user on the server", () => {
    expect(sshCommand(o)).toBe("ssh -J k7f3q9wz2m4x@acme.cloud.captivo.io:2222 deploy@10.0.0.5");
  });
  it("adds the server's port and leaves 22 out on the jump host", () => {
    expect(sshCommand({ ...o, jumpPort: 22, targetPort: 2200 })).toBe("ssh -J k7f3q9wz2m4x@acme.cloud.captivo.io -p 2200 deploy@10.0.0.5");
  });
  it("keeps a placeholder for an empty or unsafe user name", () => {
    expect(sshCommand({ ...o, user: " " })).toBe("ssh -J k7f3q9wz2m4x@acme.cloud.captivo.io:2222 USER@10.0.0.5");
    expect(sshCommand({ ...o, user: "x; rm -rf ~" })).toContain(" USER@10.0.0.5");
    expect(sshCommand({ ...o, user: "ayse@corp.local" })).toContain(" ayse@corp.local@10.0.0.5");
  });
  it("files a recorded session's key under Captivo's name", () => {
    const alias = recordedHostKeyAlias("acme.cloud.captivo.io");
    expect(sshCommand({ ...o, user: "ops", hostKeyAlias: alias })).toBe("ssh -J k7f3q9wz2m4x@acme.cloud.captivo.io:2222 -o HostKeyAlias=captivo-recorded.acme.cloud.captivo.io ops@10.0.0.5");
  });
  it("brackets an IPv6 jump host only", () => {
    expect(sshCommand({ ...o, jumpHost: "2001:db8::1", targetHost: "fd00::5" })).toBe("ssh -J k7f3q9wz2m4x@[2001:db8::1]:2222 deploy@fd00::5");
  });
});

describe("ticket codes", () => {
  it("are 12 unambiguous characters and differ each time", () => {
    const codes = new Set(Array.from({ length: 200 }, () => newSshTicketCode()));
    expect(codes.size).toBe(200);
    for (const c of codes) expect(c).toMatch(/^[a-hjkmnp-z2-9]{12}$/);
  });
});

describe("public address", () => {
  afterEach(() => {
    delete process.env.SSH_PUBLIC_HOST;
    delete process.env.SSH_PUBLIC_PORT;
  });
  it("defaults to the console host and port 2222", () => {
    expect(sshPublicHost("acme.cloud.captivo.io")).toBe("acme.cloud.captivo.io");
    expect(sshPublicPort()).toBe(2222);
  });
  it("takes the deployment's own", () => {
    process.env.SSH_PUBLIC_HOST = "ssh.example.com";
    process.env.SSH_PUBLIC_PORT = "22";
    expect(sshPublicHost("acme.cloud.captivo.io")).toBe("ssh.example.com");
    expect(sshPublicPort()).toBe(22);
    process.env.SSH_PUBLIC_PORT = "junk";
    expect(sshPublicPort()).toBe(2222);
  });
});
