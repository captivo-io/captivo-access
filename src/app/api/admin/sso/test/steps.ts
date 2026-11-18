// The SSO connection test, step by step. Pure apart from the fetches it is
// handed, so the route and its tests share it.

export type StepKey = "discovery" | "jwks" | "client";
export interface TestStep { key: StepKey; ok: boolean; detail: string }
export type TestError = "no_issuer" | "unreachable" | "private_address" | "jwks_failed" | "credentials_missing";
export interface TestResult { ok: boolean; error?: TestError; steps: TestStep[] }

export async function runSsoTest(
  cfg: { issuer: string; clientId: string; hasSecret: boolean } | null,
  io: { discover: (issuer: string) => Promise<{ jwks_uri: string }>; fetchJwks: (uri: string) => Promise<unknown> },
): Promise<TestResult> {
  if (!cfg?.issuer) return { ok: false, error: "no_issuer", steps: [{ key: "discovery", ok: false, detail: "no issuer saved" }] };
  const steps: TestStep[] = [];
  let jwksUri: string;
  try {
    jwksUri = (await io.discover(cfg.issuer)).jwks_uri;
    steps.push({ key: "discovery", ok: true, detail: "found" });
  } catch (e) {
    steps.push({ key: "discovery", ok: false, detail: short(e) });
    return { ok: false, error: isPrivate(e) ? "private_address" : "unreachable", steps };
  }
  try {
    const body = (await io.fetchJwks(jwksUri)) as { keys?: unknown };
    const n = Array.isArray(body?.keys) ? body.keys.length : 0;
    if (n === 0) throw new Error("no keys");
    steps.push({ key: "jwks", ok: true, detail: `${n} ${n === 1 ? "key" : "keys"}` });
  } catch (e) {
    steps.push({ key: "jwks", ok: false, detail: short(e) });
    return { ok: false, error: isPrivate(e) ? "private_address" : "jwks_failed", steps };
  }
  // Only whether both are saved: the secret can't be checked without a real sign-in.
  const missing = !cfg.clientId ? "client ID missing" : !cfg.hasSecret ? "client secret missing" : null;
  steps.push({ key: "client", ok: !missing, detail: missing ?? "both saved" });
  return missing ? { ok: false, error: "credentials_missing", steps } : { ok: true, steps };
}

// The Cloud guard's refusal (lib/net/guarded-fetch), recognised by name so this file stays pure.
const isPrivate = (e: unknown) => e instanceof Error && e.name === "PrivateAddressError";

function short(e: unknown): string {
  const m = e instanceof Error ? e.message : "failed";
  if (/^discovery_failed_(\d+)$/.test(m)) return `HTTP ${m.slice("discovery_failed_".length)}`;
  if (m === "discovery_incomplete") return "incomplete document";
  if (/abort|timeout/i.test(m)) return "timed out";
  return m.length > 60 ? `${m.slice(0, 57)}…` : m;
}
