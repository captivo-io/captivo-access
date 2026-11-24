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

describe("the other vaults' references", () => {
  it("check CyberArk's REST API, Azure Key Vault and AWS Secrets Manager", () => {
    const pv: VaultRef = { provider: "cyberark", mode: "pvwa", address: "https://pvwa.corp", user: "svc", password: "pw", safe: "Servers", object: "web01" };
    expect(refProblem(pv)).toBeNull();
    expect(refProblem({ ...pv, user: "" })).toMatch(/user/);
    expect(refProblem({ ...pv, safe: "", accountId: "12_3" })).toBeNull();
    expect(refProblem({ ...pv, safe: "" })).toMatch(/account id/);
    const az: VaultRef = { provider: "azure", address: "https://v.vault.azure.net", tenantId: "t", clientId: "c", clientSecret: "s", secretName: "n" };
    expect(refProblem(az)).toBeNull();
    expect(refProblem({ ...az, clientSecret: "" })).toMatch(/client id/);
    expect(refProblem({ ...az, secretName: "" })).toMatch(/name/);
    const aws: VaultRef = { provider: "aws", region: "eu-central-1", awsSecretId: "prod/web01" };
    expect(refProblem(aws)).toBeNull();
    expect(refProblem({ ...aws, region: "eu/x" })).toMatch(/region/);
    expect(refProblem({ ...aws, accessKeyId: "AKIA" })).toMatch(/secret key/);
    expect(refProblem({ ...aws, address: "https://vpce.example:443" })).toBeNull();
  });
  it("seal AWS without an endpoint and leave empty fields out", () => {
    const t = refText({ provider: "aws", region: "eu-central-1", awsSecretId: "prod/web01", accessKeyId: "", jsonKey: "password" });
    expect(JSON.parse(t.slice(REF_PREFIX.length))).toEqual({ provider: "aws", region: "eu-central-1", awsSecretId: "prod/web01", jsonKey: "password" });
  });
  it("are known to the request parser and named for people", () => {
    expect(secretInputFrom({ secret: "p", secretSource: "azure" })).toMatchObject({ source: "azure" });
    expect(secretInputFrom({ secret: "p", secretSource: "aws" })).toMatchObject({ source: "aws" });
    expect(rotationMethod({ protocol: "RDP", secretKind: "PASSWORD", username: "a", secretSource: "aws" }, null)).toEqual({ unsupported: expect.stringContaining("AWS Secrets Manager") });
    expect(rotationMethod({ protocol: "SSH", secretKind: "PASSWORD", secretSource: "azure" }, null)).toEqual({ unsupported: expect.stringContaining("Azure Key Vault") });
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
