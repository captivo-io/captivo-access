import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const CALLBACK = readFileSync(path.join(__dirname, "route.ts"), "utf-8");
const START = readFileSync(path.join(__dirname, "..", "start", "route.ts"), "utf-8");
const PASSKEY = readFileSync(path.join(__dirname, "..", "..", "authentication", "verify", "route.ts"), "utf-8");

describe("OIDC callback: the second-factor requirement", () => {
  it("is decided before anything is provisioned, consumed or opened", () => {
    // Order is the point. A refused sign-in must not have spent an invite,
    // offered a workspace, or written a session row on the way to "no".
    const gate = CALLBACK.indexOf("secondFactorGate(");
    expect(gate).toBeGreaterThan(-1);
    for (const later of ["db.user.findFirst(", "db.invite.findFirst(", "accessGrant(", "startSession("]) {
      expect(CALLBACK.indexOf(later), `${later} runs before the gate`).toBeGreaterThan(gate);
    }
  });

  it("reads the policy and the state cookie's step-up flag, not a constant", () => {
    expect(CALLBACK).toMatch(/required:\s*\(await getSessionPolicy\(\)\)\.requireSecondFactor/);
    expect(CALLBACK).toMatch(/steppedUp:\s*saved\.stepUp === true/);
  });

  it("sends an unproven first arrival back through start with stepUp, and refuses the second", () => {
    expect(CALLBACK).toMatch(/gate === "step_up"[\s\S]{0,400}?"\/api\/auth\/oidc\/start"[\s\S]{0,200}?set\("stepUp", "1"\)/);
    expect(CALLBACK).toMatch(/gate === "refuse"[\s\S]{0,400}?fail\(req, "mfa_required"/);
  });

  it("records the claim on every session it opens", () => {
    const opens = CALLBACK.match(/startSession\([^)]*\)/g) ?? [];
    expect(opens.length).toBeGreaterThan(0);
    for (const call of opens) expect(call).toMatch(/,\s*amr\)$/);
  });
});

describe("OIDC start: prompt=login", () => {
  it("is added only on a step-up, and the state cookie remembers it", () => {
    expect(START).toMatch(/if \(stepUp\) url\.searchParams\.set\("prompt", "login"\)/);
    // Exactly one place sets it, and that place is the guarded one above.
    expect(START.match(/set\("prompt"/g)).toHaveLength(1);
    expect(START).toMatch(/setOidcState\(\{[^}]*stepUp[^}]*\}\)/);
  });
});

describe("passkey sign-in: the second-factor requirement", () => {
  it("judges the ceremony's own user-verification flag and cannot step up", () => {
    expect(PASSKEY).toMatch(/passkeyAmr\(result\.authenticationInfo\.userVerified\)/);
    expect(PASSKEY).toMatch(/secondFactorGate\(\{[^}]*steppedUp:\s*true[^}]*\}\)/);
  });
  it("refuses before the session is created and records the methods on the one it creates", () => {
    const gate = PASSKEY.indexOf("secondFactorGate(");
    const refuse = PASSKEY.indexOf('"mfa_required"');
    const create = PASSKEY.indexOf("createSession(");
    expect(gate).toBeGreaterThan(-1);
    expect(refuse).toBeGreaterThan(gate);
    expect(create).toBeGreaterThan(refuse);
    expect(PASSKEY).toMatch(/createSession\(passkey\.userId, \{ \.\.\.requestMeta\(req\), amr \}\)/);
  });
});
