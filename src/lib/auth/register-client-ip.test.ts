import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const REGISTER = readFileSync(path.join(__dirname, "captivo-id-register.ts"), "utf-8");
const FLOW = readFileSync(path.join(__dirname, "..", "signup", "flow.ts"), "utf-8");
const ROUTE = readFileSync(path.join(__dirname, "..", "..", "app", "api", "signup", "verify", "route.ts"), "utf-8");

/**
 * The centre caps registrations per IP, but it cannot use the address our
 * request arrives over -- that is this container, one bucket for every
 * customer. So the cap only applies if the product supplies the end user's
 * address, and the centre skips the check entirely when it is absent:
 * `clientIp ? check(clientIp) : { allowed: true }`. Portal had always sent it;
 * this door had not, so the per-IP limit did not exist for signups here.
 */
describe("the signup door supplies the end user's address", () => {
  it("carries it in the register call", () => {
    expect(REGISTER).toMatch(/clientIp\?: string;/);
    expect(REGISTER).toMatch(/\.\.\.\(input\.clientIp \? \{ clientIp: input\.clientIp \} : \{\}\)/);
  });

  it("omits the field rather than guessing", () => {
    // A placeholder would put unrelated signups in one bucket, which is worse
    // than no cap: it would rate-limit strangers against each other.
    expect(REGISTER).not.toMatch(/clientIp: input\.clientIp \?\? ["']/);
  });

  it("threads it from the route through the flow", () => {
    expect(FLOW).toMatch(/completeSignup\(token: string, clientIp\?: string\)/);
    expect(FLOW).toMatch(/registerWithCaptivoId\(\{[^}]*clientIp \}\)/);
    expect(ROUTE).toMatch(/completeSignup\([\s\S]{0,80}?clientIp\(req\.headers\)\)/);
  });

  it("reads the address through the one trustworthy rule", () => {
    // Never the first X-Forwarded-For hop -- that is a value the caller writes,
    // and a cap keyed on it is a cap its own target can reset.
    expect(ROUTE).toMatch(/import \{ clientIp \} from "@\/lib\/request-ip"/);
    // The READ, not the name: this file's own comment explains why the first
    // hop is wrong, and forbidding the string outright failed on that comment.
    expect(ROUTE).not.toMatch(/(\.get\(|\[)\s*["']x-forwarded-for["']/i);
  });
});
