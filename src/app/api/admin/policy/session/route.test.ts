import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const SRC = readFileSync(path.join(__dirname, "route.ts"), "utf-8");

describe("session policy: turning two-step on", () => {
  it("is refused unless the caller's own current session proves a second factor", () => {
    // The check is on THIS request's session row, not on the account: what
    // matters is whether the person flipping the switch could get back in.
    expect(SRC).toMatch(/if \(requireSecondFactor\)[\s\S]{0,400}?currentSessionId\(\)[\s\S]{0,300}?hasSecondFactor\(own\.amr\)/);
    expect(SRC).toMatch(/own_session_lacks_second_factor[\s\S]{0,40}?status: 409/);
  });
  it("happens before the policy is saved", () => {
    expect(SRC.indexOf("own_session_lacks_second_factor")).toBeLessThan(SRC.indexOf("saveSessionPolicy("));
  });
  it("only an explicit true turns it on", () => {
    expect(SRC).toMatch(/const requireSecondFactor = body\.requireSecondFactor === true/);
  });
});
