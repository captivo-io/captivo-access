import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const SESSION = readFileSync(path.join(__dirname, "session.ts"), "utf-8");
const CLIENT = readFileSync(path.join(__dirname, "captivo-id-client.ts"), "utf-8");
const SUPPORT = readFileSync(path.join(__dirname, "..", "support", "session.ts"), "utf-8");

/**
 * Someone who lives in Access used to land in the Portal dashboard on every
 * sign-in. The centre remembers which product a person last entered, and each
 * product reports its own sign-ins -- a hook in the authorization path would
 * fire on token refresh too and record a landing nobody saw.
 */
describe("last product reporting", () => {
  it("reports from createSession, the one funnel every sign-in passes through", () => {
    expect(SESSION).toMatch(/reportLastProduct\(u\.email, "ACCESS"\)/);
    expect(SESSION).toMatch(/import \{ reportLastProduct \}/);
  });

  it("does not report a support session", () => {
    // A platform operator looking at a customer's console is not that customer
    // choosing a product, and recording it would move THEIR landing.
    expect(SUPPORT).not.toMatch(/reportLastProduct/);
    expect(SUPPORT).toMatch(/db\.session\.create/);
  });

  it("awaits the report instead of leaving it dangling", () => {
    // An unawaited promise can be killed when the response completes; the
    // preference would then silently never be recorded.
    expect(SESSION).toMatch(/await reportLastProduct\(u\.email, "ACCESS"\)/);
  });

  it("cannot fail a sign-in", () => {
    // Two layers: the client swallows its own transport failure, and the call
    // site swallows a lookup failure. A login must not depend on the centre.
    expect(CLIENT).toMatch(/export async function reportLastProduct[\s\S]*?\} catch \{/);
    const at = SESSION.indexOf('reportLastProduct(u.email, "ACCESS")');
    const tryAt = SESSION.lastIndexOf("try {", at);
    expect(tryAt).toBeGreaterThan(-1);
    expect(SESSION.slice(tryAt, at + 200)).toMatch(/\} catch \{/);
  });

  it("says nothing when the centre is not configured", () => {
    // Self-hosted installations have no centre; the call returns before any
    // network access rather than timing out on every single sign-in.
    expect(CLIENT).toMatch(/export async function reportLastProduct[\s\S]{0,200}?if \(!svc\) return;/);
  });
});
