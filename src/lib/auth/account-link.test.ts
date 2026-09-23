import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { captivoAccountUrl } from "./captivo-id-client";

const TOPNAV = readFileSync(path.join(__dirname, "..", "..", "app", "(app)", "_shell", "topnav.tsx"), "utf-8");

/**
 * The account page shipped with nothing anywhere linking to it. The person who
 * built it could not find it either, which is the whole measure of a
 * discoverability bug: if the author cannot find it, no customer will.
 */
describe("the Captivo account link", () => {
  it("is null with no centre, so a self-hosted console offers no dead link", () => {
    expect(captivoAccountUrl({})).toBeNull();
    expect(captivoAccountUrl({ CAPTIVO_ID_ISSUER: "https://id.example" })).toBeNull();
  });

  it("derives the address from the configured issuer", () => {
    // A staging console must link to the staging centre, not to production.
    expect(captivoAccountUrl({
      CAPTIVO_ID_ISSUER: "https://id.staging.example",
      CAPTIVO_ID_SERVICE_SECRET: "s",
    })).toBe("https://id.staging.example/account");
  });

  it("renders nothing when there is no address", () => {
    expect(TOPNAV).toMatch(/\{accountUrl && \(/);
  });

  it("leaves the host with a plain anchor, not next/link", () => {
    // next/link is for routes inside this app; the account page is another
    // origin entirely.
    expect(TOPNAV).toMatch(/<a href=\{accountUrl\}[\s\S]{0,140}?target="_blank"[\s\S]{0,60}?rel="noopener noreferrer"/);
  });
});
