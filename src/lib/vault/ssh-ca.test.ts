import { describe, it, expect } from "vitest";
import { isSshCa, isSshCaKey, sshCaProblem, sshCaServerSetup, trustedCaFile } from "@/lib/vault/ssh-ca";
import { providerLabel, REF_PREFIX, SSH_CA_REF_TEXT } from "@/lib/vault/providers";
import { secretInputFrom } from "@/lib/vault/secret-input";
import { rotationMethod } from "@/lib/vault/rotation";

const KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJ9bX0m1cV7eT0b1Yk2pQ0o5a3o0sY0xv7oQe3Xc2kqL";

describe("certificate sign-in rules", () => {
  it("is for SSH resources used through the user's own client, recorded", () => {
    expect(sshCaProblem({ protocol: "SSH", nativeSsh: true, recorded: true })).toBeNull();
    expect(sshCaProblem({ protocol: "RDP", nativeSsh: true, recorded: true })).toBe("ssh_ca_ssh_only");
    expect(sshCaProblem({ protocol: undefined, nativeSsh: true, recorded: true })).toBe("ssh_ca_ssh_only");
    expect(sshCaProblem({ protocol: "ssh", nativeSsh: false, recorded: true })).toBe("ssh_ca_needs_native");
    expect(sshCaProblem({ protocol: "SSH", nativeSsh: true, recorded: false })).toBe("ssh_ca_needs_recording");
  });

  it("is stored as a sealed reference, so rotation, check-out and reveal stay away from it", () => {
    expect(SSH_CA_REF_TEXT).toBe(`${REF_PREFIX}{"provider":"sshca"}`);
    expect(secretInputFrom({ sealedSecret: "cv1:x", sealedTo: "k", secretSource: "sshca" })).toMatchObject({ source: "sshca" });
    expect(isSshCa({ secretSource: "sshca" })).toBe(true);
    expect(isSshCa({ secretSource: "hashicorp" })).toBe(false);
    expect(isSshCa(null)).toBe(false);
    expect(providerLabel("sshca")).toBe("SSH certificates");
    const m = rotationMethod({ protocol: "SSH", secretKind: "PASSWORD", secretSource: "sshca" }, null);
    expect("unsupported" in m && m.unsupported).toMatch(/no password to rotate/);
  });
});

describe("the CA key the connector reports", () => {
  it("accepts one ssh-ed25519 line and nothing else", () => {
    expect(isSshCaKey(KEY)).toBe(true);
    expect(isSshCaKey(KEY + " ana@acme")).toBe(false);
    expect(isSshCaKey(KEY + "\nssh-rsa AAAA")).toBe(false);
    expect(isSshCaKey("ssh-rsa " + KEY.slice(12))).toBe(false);
    expect(isSshCaKey("")).toBe(false);
    expect(isSshCaKey(undefined)).toBe(false);
  });

  it("lists each connector's key once for the server's trusted file", () => {
    const other = KEY.replace("kqL", "kqM");
    expect(trustedCaFile([KEY, null, KEY, other])).toBe(`${KEY}\n${other}`);
  });

  it("builds the server commands without letting a key break out of the quotes", () => {
    const text = sshCaServerSetup([KEY]);
    expect(text).toContain("TrustedUserCAKeys /etc/ssh/captivo_ca.pub");
    expect(text).toContain("sshd -t");
    expect(sshCaServerSetup(["a'b"])).toContain("echo 'a'\\''b'");
  });
});
