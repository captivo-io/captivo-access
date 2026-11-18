import { describe, it, expect } from "vitest";
import { readDirectoryTest, pemState } from "./test-steps";

describe("readDirectoryTest", () => {
  it("passes every step when bound and the base DN is found", () => {
    expect(readDirectoryTest({ ok: true, baseDnFound: true })).toEqual({ ok: true, failedAt: null, message: null });
  });
  it("stops at the base DN search when bound but nothing was found", () => {
    expect(readDirectoryTest({ ok: true, baseDnFound: false }).failedAt).toBe(4);
    expect(readDirectoryTest({ ok: true, error: "bound OK, but the base DN search failed: No Such Object" }).failedAt).toBe(4);
  });
  it("places the data plane's messages on their step", () => {
    const at = (error: string) => readDirectoryTest({ ok: false, error }).failedAt;
    expect(at("connector offline")).toBe(0);
    expect(at("The data-plane is unreachable.")).toBe(0);
    expect(at("Choose a connector and save the directory settings first.")).toBe(0);
    expect(at("Host, base DN and bind DN are required — save them first.")).toBe(1);
    expect(at("dial tcp 10.0.0.5:636: connect: connection refused")).toBe(1);
    expect(at("dial tcp: lookup dc01.corp.local: no such host")).toBe(1);
    expect(at("TLS certificate could not be verified — paste the CA … (x509: certificate signed by unknown authority)")).toBe(2);
    expect(at("the directory did not complete a TLS handshake — LDAPS is not enabled on it.")).toBe(2);
    expect(at("bind failed: LDAP Result Code 49 \"Invalid Credentials\"")).toBe(3);
    expect(at("something odd")).toBe(3);
  });
});

describe("pemState", () => {
  it("tells empty, valid and unrecognised apart", () => {
    expect(pemState("  ")).toBe("none");
    expect(pemState("-----BEGIN CERTIFICATE-----\nMIIBszCCAVmgAwIBAgIU\nabc+/=\n-----END CERTIFICATE-----\n")).toBe("ok");
    expect(pemState("hello")).toBe("bad");
    expect(pemState("-----BEGIN CERTIFICATE-----\nnot base64 !!\n-----END CERTIFICATE-----")).toBe("bad");
  });
});
