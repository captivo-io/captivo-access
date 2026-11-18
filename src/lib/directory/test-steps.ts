// How the Directory page reads one connection test. The data plane runs the
// whole test (connector → TCP → TLS → bind → base DN search) and reports one
// message; this maps that message to the step it failed at, so the page can
// show where it stopped without inventing figures. Pure, for the tests.

export const TEST_STEPS = [
  "Connector reached",
  "TCP connection to host",
  "TLS handshake",
  "Bind with service account",
  "Base DN search",
] as const;

export interface TestOutcome {
  ok: boolean;
  /** Index into TEST_STEPS that failed; null when every step passed. */
  failedAt: number | null;
  message: string | null;
}

export function readDirectoryTest(r: { ok?: boolean; baseDnFound?: boolean; error?: string | null }): TestOutcome {
  const err = r.error?.trim() || null;
  if (r.ok && !err && r.baseDnFound) return { ok: true, failedAt: null, message: null };
  // Bound, then the base DN search failed or found nothing.
  if (r.ok) return { ok: false, failedAt: 4, message: err ?? "The base DN was not found." };
  return { ok: false, failedAt: failedStep(err ?? ""), message: err ?? "The directory test failed." };
}

function failedStep(msg: string): number {
  const m = msg.toLowerCase();
  if (/connector offline|data-plane is unreachable|test request failed|choose a connector/.test(m)) return 0;
  if (/bind failed|invalid credentials|result code 49/.test(m)) return 3;
  if (/base dn/.test(m) && !/required/.test(m)) return 4;
  if (/tls|x509|certificate|ldaps|starttls|handshake/.test(m)) return 2;
  if (/required|dial|refused|timed? ?out|no such host|unreachable|network|connection|lookup|eof/.test(m)) return 1;
  return 3;
}

export type PemState = "none" | "ok" | "bad";

/** A light shape check of a pasted CA: one or more BEGIN/END CERTIFICATE blocks. */
export function pemState(text: string): PemState {
  const t = text.trim();
  if (!t) return "none";
  const blocks = t.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g);
  if (!blocks) return "bad";
  return blocks.every((b) => /^-----BEGIN CERTIFICATE-----\s*[A-Za-z0-9+/=\s]+\s*-----END CERTIFICATE-----$/.test(b)) ? "ok" : "bad";
}
