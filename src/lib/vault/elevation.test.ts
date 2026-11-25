import { describe, it, expect } from "vitest";
import { elevationProblem } from "@/lib/vault/elevation";

const ok = { protocol: "SSH", nativeSsh: true, recorded: true, account: "root", username: "deploy" };

describe("administrator rights during sessions", () => {
  it("is for an ordinary SSH account on the recorded native path, with an administrator account", () => {
    expect(elevationProblem(ok)).toBeNull();
    expect(elevationProblem({ ...ok, protocol: "RDP" })).toBe("elevate_ssh_only");
    expect(elevationProblem({ ...ok, nativeSsh: false })).toBe("elevate_needs_native");
    expect(elevationProblem({ ...ok, recorded: false })).toBe("elevate_needs_recording");
    expect(elevationProblem({ ...ok, account: null })).toBe("elevate_needs_account");
  });

  it("refuses root and names sudoers.d would skip or a shell could misread", () => {
    for (const u of ["root", "Deploy", "a.b", "a b", "a;b", "", "x".repeat(40)]) expect(elevationProblem({ ...ok, username: u })).toBe("elevate_root");
    for (const u of ["deploy", "_svc", "web-1"]) expect(elevationProblem({ ...ok, username: u })).toBeNull();
  });
});
