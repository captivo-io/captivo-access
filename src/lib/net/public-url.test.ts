import { describe, it, expect } from "vitest";
import { isPrivateAddress, publicUrlProblem } from "./public-url";

describe("public URL check", () => {
  it("spots private, loopback and link-local addresses", () => {
    for (const ip of ["10.1.2.3", "127.0.0.1", "169.254.169.254", "172.20.0.5", "192.168.1.1", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1"]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "172.32.0.1"]) expect(isPrivateAddress(ip), ip).toBe(false);
  });
  it("refuses literal private hosts without a lookup", async () => {
    expect(await publicUrlProblem("http://169.254.169.254/latest")).toBe("private_address");
    expect(await publicUrlProblem("http://[::1]:8080/")).toBe("private_address");
    expect(await publicUrlProblem("ftp://example.com")).toBe("invalid_url");
  });
});
