import { createHash } from "node:crypto";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { appRedirect, isPkceChallenge, pkceMatches, readHandoff, signHandoff } from "../handoff";

const verifier = "v".repeat(64);
const challenge = createHash("sha256").update(verifier).digest("base64url");

beforeEach(() => vi.stubEnv("SESSION_SECRET", "x".repeat(32)));

describe("app sign-in hand-off", () => {
  it("accepts only an S256 challenge", () => {
    expect(isPkceChallenge(challenge)).toBe(true);
    expect(isPkceChallenge("short")).toBe(false);
    expect(isPkceChallenge(challenge + "=")).toBe(false);
  });

  it("the verifier must hash to the challenge", () => {
    expect(pkceMatches(verifier, challenge)).toBe(true);
    expect(pkceMatches("w".repeat(64), challenge)).toBe(false);
    expect(pkceMatches(undefined, challenge)).toBe(false);
  });

  it("the cookie round-trips, then expires", () => {
    const now = Date.now();
    const v = signHandoff(challenge, now);
    expect(readHandoff(v, now)).toBe(challenge);
    expect(readHandoff(v, now + 11 * 60 * 1000)).toBeNull();
  });

  it("a cookie with another challenge or another secret is refused", () => {
    const v = signHandoff(challenge);
    const [, exp, sig] = v.split(".");
    const other = createHash("sha256").update("o".repeat(64)).digest("base64url");
    expect(readHandoff(`${other}.${exp}.${sig}`)).toBeNull();
    vi.stubEnv("SESSION_SECRET", "y".repeat(32));
    expect(readHandoff(v)).toBeNull();
  });

  it("only ever sends the browser back to the app's own address", () => {
    expect(appRedirect({ code: "abc" })).toBe("captivo://auth/access?code=abc");
  });
});
