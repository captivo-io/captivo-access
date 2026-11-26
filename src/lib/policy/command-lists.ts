// Named allow/deny command lists (CommandList). Pure validation and compilation; the
// routes load and save. See dataplane/cmdfilter.go for what a list does and does not
// guarantee: exact where a command arrives whole (SSH exec, Kubernetes exec argv, Redis,
// MongoDB), a guardrail on a typed shell line.

export const COMMAND_LIST_MODES = ["allow", "deny"] as const;
export type CommandListMode = (typeof COMMAND_LIST_MODES)[number];

export const MAX_COMMAND_LISTS = 5;
export const MAX_ENTRIES = 200;
export const MAX_ENTRY_LENGTH = 200;
export const MAX_NAME_LENGTH = 48;

export type CommandListInput = { name: string; description: string | null; mode: CommandListMode; entries: string[] };

/** What the data plane receives with a resource's target. */
export type CompiledCommandList = { mode: CommandListMode; entries: string[]; name: string };

export function isCommandListMode(v: unknown): v is CommandListMode {
  return typeof v === "string" && (COMMAND_LIST_MODES as readonly string[]).includes(v);
}

/** One entry per line, or an array; trimmed, blanks and duplicates dropped (case-insensitively). */
export function parseEntries(raw: unknown): string[] | null {
  const lines = typeof raw === "string" ? raw.split(/\r?\n/) : Array.isArray(raw) ? raw : null;
  if (!lines) return null;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const l of lines) {
    if (typeof l !== "string") return null;
    const e = l.replace(/\s+/g, " ").trim();
    if (!e) continue;
    const k = e.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(e);
  }
  return out;
}

export type CommandListError = "invalid_name" | "name_too_long" | "invalid_mode" | "invalid_entries" | "too_many_entries" | "entry_too_long" | "entry_has_control" | "invalid_description";

export function validateCommandList(body: Record<string, unknown>): { ok: true; value: CommandListInput } | { ok: false; error: CommandListError } {
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return { ok: false, error: "invalid_name" };
  if (name.length > MAX_NAME_LENGTH) return { ok: false, error: "name_too_long" };
  if (!isCommandListMode(body.mode)) return { ok: false, error: "invalid_mode" };
  const entries = parseEntries(body.entries);
  if (!entries) return { ok: false, error: "invalid_entries" };
  if (entries.length > MAX_ENTRIES) return { ok: false, error: "too_many_entries" };
  for (const e of entries) {
    if (e.length > MAX_ENTRY_LENGTH) return { ok: false, error: "entry_too_long" };
    if (/[\u0000-\u001f\u007f]/.test(e)) return { ok: false, error: "entry_has_control" };
  }
  const description = typeof body.description === "string" && body.description.trim() ? body.description.trim().slice(0, 200) : null;
  if (body.description != null && typeof body.description !== "string") return { ok: false, error: "invalid_description" };
  return { ok: true, value: { name, description, mode: body.mode, entries } };
}

export function compileCommandList(l: { name: string; mode: string; entries: string[] } | null | undefined): CompiledCommandList | null {
  if (!l || !isCommandListMode(l.mode)) return null;
  return { mode: l.mode, entries: l.entries, name: l.name };
}

/** One line for a list: what it does, for lists and pickers. */
export function describeCommandList(l: { mode: string; entries: string[] }): string {
  const n = l.entries.length;
  if (l.mode === "allow") return n === 0 ? "Allow list: nothing may run" : `Allow list: only ${n} ${n === 1 ? "command" : "commands"} may run`;
  return n === 0 ? "Deny list: nothing is blocked yet" : `Deny list: ${n} ${n === 1 ? "command is" : "commands are"} blocked`;
}
