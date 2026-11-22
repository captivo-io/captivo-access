/**
 * Reassemble a keystroke timeline from what the connector streams back.
 *
 * The connector stores keystroke batches as newline-terminated JSON ("keys" chunks,
 * see dataplane/keywriter.go) and returns them decrypted and in order. Nothing is
 * decrypted here -- the control plane holds no key, by design.
 *
 * A masked entry's text is replaced rather than returned: a masked line is a password
 * prompt. The connector's own search already refuses to match masked text, and this
 * is the same rule applied on the way out, so neither path can leak it.
 */
export type KeyEvent = {
  atMs: number; kind: string; masked: boolean; text: string;
  /** A database statement (kind "query"): how long it ran, the rows it returned or touched, its error. */
  ms?: number; rows?: number; error?: string; code?: string; db?: string;
};

export function assembleKeyEvents(raw: Buffer | Uint8Array | string): KeyEvent[] {
  const text = typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8");
  const out: KeyEvent[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let batch: unknown;
    try {
      batch = JSON.parse(trimmed);
    } catch {
      continue; // skip a corrupt batch rather than lose the whole timeline
    }
    if (!Array.isArray(batch)) continue;
    for (const e of batch) {
      if (!e || typeof e !== "object") continue;
      const ev = e as { atMs?: unknown; kind?: unknown; text?: unknown; masked?: unknown; ms?: unknown; rows?: unknown; error?: unknown; code?: unknown; db?: unknown };
      const masked = ev.masked === true;
      const kind = ev.kind === "command" || ev.kind === "query" || ev.kind === "session" ? ev.kind : "text";
      const k: KeyEvent = {
        atMs: typeof ev.atMs === "number" ? ev.atMs : 0,
        kind,
        masked,
        text: masked ? "••••" : typeof ev.text === "string" ? ev.text : "",
      };
      if (kind === "query") {
        if (typeof ev.ms === "number") k.ms = ev.ms;
        if (typeof ev.rows === "number") k.rows = ev.rows;
        if (typeof ev.error === "string" && ev.error) k.error = ev.error;
        if (typeof ev.code === "string" && ev.code) k.code = ev.code;
        if (typeof ev.db === "string" && ev.db) k.db = ev.db;
      }
      out.push(k);
    }
  }
  return out.sort((a, b) => a.atMs - b.atMs);
}
