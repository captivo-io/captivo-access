/**
 * Reassemble an rrweb recording from what the connector streams back.
 *
 * The connector holds the bytes, decrypts them with its own key and returns the
 * chunks in order, concatenated. Each chunk is one newline-terminated JSON batch
 * (NDJSON), because "[...][...]" is not parseable while "[...]\n[...]" is -- see
 * dataplane/recrrweb.go, which adds the newline.
 *
 * Neither decryption nor gunzip happens here any more: the control plane holds no
 * key, and it is not supposed to. A line that fails to parse is skipped, so one
 * corrupt batch cannot break a whole replay -- the same tolerance the old
 * per-chunk version had.
 */
export function assembleEvents(raw: Buffer | Uint8Array | string): unknown[] {
  const text = typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8");
  const out: unknown[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) out.push(...parsed);
      else out.push(parsed);
    } catch {
      /* skip a corrupt batch */
    }
  }
  return out;
}
