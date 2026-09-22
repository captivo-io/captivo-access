import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { clientIp } from "./request-ip";

const h = (o: Record<string, string>) => new Headers(o);

const REAL = "203.0.113.7";
// Never equal to REAL: identical values make "the proxy's value wins" and
// "the caller's value wins" produce the same answer.
const FORGED = "198.51.100.66";

describe("client address", () => {
  it("prefers the X-Real-IP the proxy wrote", () => {
    expect(clientIp(h({ "x-real-ip": REAL, "x-forwarded-for": `${FORGED}, ${REAL}` }))).toBe(REAL);
  });

  it("takes the LAST X-Forwarded-For hop, not the first", () => {
    expect(clientIp(h({ "x-forwarded-for": `${FORGED}, ${REAL}` }))).toBe(REAL);
  });

  it("answers undefined when no header is usable", () => {
    expect(clientIp(h({}))).toBeUndefined();
    expect(clientIp(h({ "x-forwarded-for": "" }))).toBeUndefined();
  });
});

// Files allowed to name these headers: the rule itself, and this test.
const ALLOWED = new Set(["lib/request-ip.ts", "lib/request-ip.test.ts"]);

function sourceFiles(dir: string, root: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, root, out);
    else if (/\.tsx?$/.test(entry)) out.push(path.relative(root, full));
  }
  return out;
}

describe("one copy of the rule", () => {
  it("no other file reads the proxy headers directly", () => {
    // Two session writers kept their own copy -- reading the FIRST hop, the
    // one the caller types -- so the origin recorded against a sign-in, and
    // against a support session on a customer tenant, was forgeable.
    //
    // Matched on the header NAME in quotes, saying nothing about the variable
    // it is read from: the Portal version of this guard was anchored on
    // `headers.get(` and silently missed `headersList.get(`.
    const root = path.join(__dirname, "..");
    const offenders = sourceFiles(root, root)
      .filter((f) => !ALLOWED.has(f.split(path.sep).join("/")))
      .filter((f) => /(\.get\(|\[)\s*["'](cf-connecting-ip|x-forwarded-for|x-real-ip)["']/i
        .test(readFileSync(path.join(root, f), "utf-8")));
    expect(offenders).toEqual([]);
  });
});
