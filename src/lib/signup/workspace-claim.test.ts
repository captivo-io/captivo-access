import { describe, it, expect } from "vitest";
import { signWorkspaceClaim, readWorkspaceClaim } from "./workspace-claim";

const SECRET = "s".repeat(32);
const claim = { org: "org_1", orgName: "Acme", email: "a@b.co" };

describe("workspace claim", () => {
  it("round-trips what it was given", () => {
    const c = readWorkspaceClaim(signWorkspaceClaim(claim, SECRET), SECRET);
    expect(c).toMatchObject(claim);
  });

  it("rejects a tampered payload", () => {
    // The whole reason it is signed: the next step creates a workspace for
    // whichever organisation it is handed.
    const t = signWorkspaceClaim(claim, SECRET);
    const [p, s] = t.split(".");
    const evil = Buffer.from(JSON.stringify({ ...claim, org: "org_2", exp: Date.now() + 60000 })).toString("base64url");
    expect(readWorkspaceClaim(`${evil}.${s}`, SECRET)).toBeNull();
    expect(readWorkspaceClaim(`${p}.${"a".repeat(s!.length)}`, SECRET)).toBeNull();
  });

  it("rejects a claim signed with another secret", () => {
    expect(readWorkspaceClaim(signWorkspaceClaim(claim, "x".repeat(32)), SECRET)).toBeNull();
  });

  it("expires", () => {
    const t = signWorkspaceClaim(claim, SECRET, 0);
    expect(readWorkspaceClaim(t, SECRET, 16 * 60 * 1000)).toBeNull();
  });

  it("rejects malformed input without throwing", () => {
    for (const bad of [undefined, "", "no-dot", "a.b", "...."]) {
      expect(readWorkspaceClaim(bad as string | undefined, SECRET)).toBeNull();
    }
  });
});
