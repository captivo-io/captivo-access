import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { DEFAULT_SCOPE_BUDGET_MS, SLOW_SCOPE_BUDGET_MS } from "@/lib/tenant/scope";
import { buildTransportOptions } from "@/lib/email/transport";

/**
 * Node's fetch applies NO timeout, and nodemailer and dns.promises do not either.
 * Every call here leaves for someone else's machine -- a connector on a customer's
 * network, their directory server, their mail relay, their IdP -- so an unbounded
 * one waits forever.
 *
 * Until these were added the ceiling was an accident: cloud requests run inside a
 * tenant scope, which is a transaction with a budget, so the transaction expiring
 * was what ended the wait -- surfacing as a P2028 naming a Prisma model, nowhere
 * near the call that hung. Raising that budget for slow routes removes the
 * accident, so the ceilings have to be real.
 */
function stripCommentsAndStrings(src: string): string {
  let out = "", i = 0;
  while (i < src.length) {
    const two = src.slice(i, i + 2);
    if (two === "//") { while (i < src.length && src[i] !== "\n") i++; continue; }
    if (two === "/*") { i += 2; while (i < src.length && src.slice(i, i + 2) !== "*/") i++; i += 2; continue; }
    const q = src[i];
    if (q === '"' || q === "'" || q === "`") {
      i++;
      while (i < src.length && src[i] !== q) { if (src[i] === "\\") i++; i++; }
      i++;
      out += '""';
      continue;
    }
    out += src[i]; i++;
  }
  return out;
}

function serverSources(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) {
      if (["generated", "node_modules", "recorder"].includes(e.name)) continue;
      out.push(...serverSources(p));
    } else if (/\.tsx?$/.test(e.name) && !/\.test\./.test(e.name)) {
      const raw = readFileSync(p, "utf8");
      // Browser code cannot hold a server transaction, and its fetches are the
      // browser's problem. Skipping them is what made this scan usable at all.
      if (/^\s*["']use client["']/.test(raw)) continue;
      out.push(p);
    }
  }
  return out;
}

describe("outbound calls are bounded", () => {
  it("no server-side fetch is left without a ceiling", () => {
    const naked: string[] = [];
    for (const f of serverSources("src")) {
      const code = stripCommentsAndStrings(readFileSync(f, "utf8"));
      const calls = (code.match(/\bfetch\s*\(/g) ?? []).length;
      if (calls === 0) continue;
      // Either routed through the helpers, or carrying an explicit signal.
      const bounded =
        (code.match(/fetchWithTimeout\s*\(|fetchStreamWithHeaderTimeout\s*\(/g) ?? []).length +
        (code.match(/signal\s*:/g) ?? []).length;
      // The helpers call fetch themselves; that one is the implementation.
      const allowed = f.endsWith("lib/net/fetch-timeout.ts") ? calls : 0;
      if (calls > bounded + allowed) naked.push(`${f} (fetch:${calls} bounded:${bounded})`);
    }
    expect(naked, "an unbounded outbound call waits forever").toEqual([]);
  });

  it("SMTP sends carry all three nodemailer ceilings", () => {
    // Asserted on the RETURNED OPTIONS, not on the source. Grepping the file for
    // "socketTimeout:" also matches the type declaration, so deleting the actual
    // value left the check passing -- a test that cannot fail for its own reason.
    const opts = buildTransportOptions({
      host: "smtp.example.com",
      port: 587,
      secure: false,
      username: "u",
      password: "p",
    }) as Record<string, unknown>;
    // Three separate ways to hang: the connect, the greeting, and any later exchange.
    for (const k of ["connectionTimeout", "greetingTimeout", "socketTimeout"]) {
      expect(typeof opts[k], `transport sets no ${k}`).toBe("number");
      expect(opts[k] as number, `${k} must be a real ceiling`).toBeGreaterThan(0);
    }
  });

  it("DNS lookups go through the one bounded resolver", () => {
    const offenders: string[] = [];
    for (const f of serverSources("src")) {
      if (f.endsWith("lib/site/verify-domain.ts")) continue;
      const code = stripCommentsAndStrings(readFileSync(f, "utf8"));
      if (/\bdns\.(resolve|lookup)/.test(code)) offenders.push(f);
    }
    expect(offenders, "dns.promises takes no per-call timeout; use resolve4()").toEqual([]);
  });
});

describe("the slow-route budget outlasts what those routes wait on", () => {
  const SLOW_DIR = "src/app/api";

  it("is longer than the default, or opting in buys nothing", () => {
    expect(SLOW_SCOPE_BUDGET_MS).toBeGreaterThan(DEFAULT_SCOPE_BUDGET_MS);
  });

  it("outlasts every ceiling a route can await", () => {
    // Highest downstream ceiling in the codebase. A budget below it would pre-empt
    // a call that was still within its own limit -- which is the original bug: the
    // LDAP probe allows 12 s (dataplane/ldap.go) and the 5 s default killed it.
    const ceilings: number[] = [];
    for (const f of serverSources("src/lib")) {
      const code = stripCommentsAndStrings(readFileSync(f, "utf8"));
      for (const m of code.matchAll(/TIMEOUT_MS\s*=\s*([0-9_]+)/g)) {
        ceilings.push(Number(m[1].replace(/_/g, "")));
      }
    }
    expect(ceilings.length, "no ceilings found to compare against").toBeGreaterThan(3);
    // File transfer is deliberately far longer and is head-bounded at the scope
    // level, so compare against the rest.
    const relevant = ceilings.filter((c) => c <= 60_000);
    expect(SLOW_SCOPE_BUDGET_MS).toBeGreaterThan(Math.max(...relevant));
  });

  it("every route that awaits a third party opts in", () => {
    // The list is the audit's result. A new route that reaches a customer's network
    // must join it deliberately, not by being forgotten.
    const SLOW = [
      "admin/directory/test", "admin/directory/resolve-preview",
      "admin/sites/[id]/test", "admin/sites/[id]/verify-domain",
      "admin/smtp/test", "admin/domain/verify", "admin/updates/check",
      "auth/oidc/callback", "isolated/files/download", "isolated/files/upload",
      "admin/recordings/[id]/video", "admin/recordings/[id]/guac",
      "admin/recordings/[id]/events", "admin/recordings/[id]/keyevents",
      "admin/connectors/[id]/repair", "admin/connectors/[id]/log-level",
      "admin/connectors/[id]/egress-policy", "admin/policy/connector-log-level/reset-all",
      "admin/invites", "admin/invites/[id]/resend", "admin/grants/[id]/decision",
      "access/requests",
    ];
    const missing: string[] = [];
    for (const r of SLOW) {
      const src = readFileSync(`${SLOW_DIR}/${r}/route.ts`, "utf8");
      const wrappers = (src.match(/= withTenantRoute\(/g) ?? []).length;
      const opted = (src.match(/budgetMs: SLOW_SCOPE_BUDGET_MS/g) ?? []).length;
      if (wrappers !== opted) missing.push(`${r} (${opted}/${wrappers})`);
    }
    expect(missing, "these routes still run on the 5 s default").toEqual([]);
  });
});
