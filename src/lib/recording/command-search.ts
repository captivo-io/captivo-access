/**
 * The command-search RULE, kept as the written reference for the connector's copy.
 *
 * The scan itself moved: keystroke text lives in each connector's own store now, so
 * matching happens there (connector/recsearch.go) and this module no longer reads
 * the database. What stays is the rule, because two implementations of one rule
 * drift unless one of them is the stated source:
 *
 *   - case-insensitive substring
 *   - an empty query never matches (an empty needle would match everything)
 *   - a chunk that cannot be decrypted or parsed is skipped, never thrown
 *   - masked entries are never searched: a line is masked because it is a password
 *     prompt, and matching it leaks what masking exists to hide
 *
 * The former central scanner (scanDecryptedMatches) is gone with the central
 * keystroke table. Do not reintroduce it: it could only work by pulling the text
 * back into the control plane.
 */

/** Case-insensitive substring. An empty query never matches. */
export function commandTextMatches(decrypted: string, query: string): boolean {
  if (!query) return false;
  return decrypted.toLowerCase().includes(query.toLowerCase());
}
