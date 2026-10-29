import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const CALLBACK = readFileSync(path.join(__dirname, "route.ts"), "utf-8");
const LOGIN = readFileSync(path.join(__dirname, "..", "..", "..", "..", "login", "page.tsx"), "utf-8");

describe("OIDC callback: an address Captivo ID has not verified", () => {
  it("gets its own code only from the platform's provider", () => {
    expect(CALLBACK).toMatch(/checked\.reason === "email_verified" && cfg\.isPlatform\)\s*\{\s*return fail\(req, "email_unverified"/);
  });

  it("is refused before anything is provisioned", () => {
    const refuse = CALLBACK.indexOf('"email_unverified"');
    expect(refuse).toBeGreaterThan(-1);
    for (const later of ["db.user.findFirst(", "db.invite.findFirst(", "startSession("]) {
      expect(CALLBACK.indexOf(later), `${later} runs before the refusal`).toBeGreaterThan(refuse);
    }
  });

  it("the login page explains it and links the Captivo account page", () => {
    expect(LOGIN).toMatch(/errorCode === "email_unverified" && sso\?\.isPlatform === true \? unverifiedMessage\(captivoAccountUrl\(\)\)/);
    expect(LOGIN).toContain("Your e-mail address is not verified yet.");
  });
});
