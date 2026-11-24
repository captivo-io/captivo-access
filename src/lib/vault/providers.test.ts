import { describe, expect, it } from "vitest";
import { refProblem, refText, REF_PREFIX, type VaultRef } from "./providers";
import { secretInputFrom } from "./secret-input";
import { storedSecretColumns } from "./store";
import { rotationMethod } from "./rotation";

const hv: VaultRef = { provider: "hashicorp", address: " https://vault.corp:8200 ", path: "servers/web01", auth: "token", token: "s.abc", mount: "", field: "", namespace: undefined, insecure: false };

describe("vault references", () => {
  it("seal as a prefixed JSON with the empty fields left out", () => {
    const t = refText(hv);
    expect(t.startsWith(REF_PREFIX)).toBe(true);
    expect(JSON.parse(t.slice(REF_PREFIX.length))).toEqual({ provider: "hashicorp", address: "https://vault.corp:8200", path: "servers/web01", auth: "token", token: "s.abc" });
  });
  it("say what is missing", () => {
    expect(refProblem(hv)).toBeNull();
    expect(refProblem({ ...hv, address: "vault.corp" })).toMatch(/address/);
    expect(refProblem({ ...hv, address: "https://u:p@vault.corp" })).toMatch(/address/);
    expect(refProblem({ ...hv, path: " / " })).toMatch(/path/);
    expect(refProblem({ ...hv, token: "" })).toMatch(/token/);
    expect(refProblem({ ...hv, auth: "approle", roleId: "r" })).toMatch(/role id/);
    expect(refProblem({ ...hv, caPem: "nope" })).toMatch(/CA/);
    const ca: VaultRef = { provider: "cyberark", address: "https://cyberark.corp", appId: "Captivo", safe: "Servers", object: "web01" };
    expect(refProblem(ca)).toBeNull();
    expect(refProblem({ ...ca, safe: "" })).toMatch(/safe/);
    expect(refProblem({ ...ca, clientCert: "x" })).toMatch(/private key/);
  });
});

describe("a secret that lives in a vault", () => {
  it("is read from the request, only for the known providers", () => {
    expect(secretInputFrom({ sealedSecret: "cv1:x", sealedTo: "k", secretSource: "hashicorp" })).toMatchObject({ source: "hashicorp" });
    expect(secretInputFrom({ secret: "p", secretSource: "cyberark" })).toMatchObject({ source: "cyberark" });
    expect(secretInputFrom({ secret: "p", secretSource: "lastpass" })).toEqual({ secret: "p" });
    expect(secretInputFrom({ secret: "p" })).toEqual({ secret: "p" });
  });
  it("is written only when a secret is newly entered, never when a seal is merely copied", () => {
    expect(storedSecretColumns({ secret: "cv1:x", sealedTo: "k", source: "hashicorp" })).toMatchObject({ secretSource: "hashicorp" });
    expect(storedSecretColumns({ secret: "cv1:x", sealedTo: "k", source: null })).toMatchObject({ secretSource: null });
    expect(storedSecretColumns({ secret: "cv1:x", sealedTo: "k" })).not.toHaveProperty("secretSource");
  });
  it("is not rotated by Captivo", () => {
    expect(rotationMethod({ protocol: "SSH", secretKind: "PASSWORD", secretSource: "hashicorp" }, null)).toEqual({ unsupported: expect.stringContaining("HashiCorp Vault") });
    expect(rotationMethod({ protocol: "RDP", secretKind: "PASSWORD", username: "Administrator", secretSource: "cyberark" }, null)).toEqual({ unsupported: expect.stringContaining("CyberArk") });
    expect(rotationMethod({ protocol: "SSH", secretKind: "PASSWORD", secretSource: null }, null)).toEqual({ method: "linux" });
  });
});
