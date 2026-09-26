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
export type KeyEvent = { atMs: number; kind: string; masked: boolean; text: string };

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
      const ev = e as { atMs?: unknown; kind?: unknown; text?: unknown; masked?: unknown };
      const masked = ev.masked === true;
      out.push({
        atMs: typeof ev.atMs === "number" ? ev.atMs : 0,
        kind: ev.kind === "command" ? "command" : "text",
        masked,
        text: masked ? "••••" : typeof ev.text === "string" ? ev.text : "",
      });
    }
  }
  return out.sort((a, b) => a.atMs - b.atMs);
}
