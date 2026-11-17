// Pretty-prints a `docker run` one-liner into a readable multi-line form with
// backslash continuations. Pure and deterministic — used only for DISPLAY; the
// original one-liner is what callers copy. A string that is not a `docker run`
// command is returned unchanged.
export function formatDockerRun(oneLiner: string): string {
  // A double-quoted stretch ("$(hostname -I 2>/dev/null)") stays one token.
  const tokens = oneLiner.trim().match(/(?:[^\s"]+|"[^"]*")+/g) ?? [];
  if (tokens[0] !== "docker" || tokens[1] !== "run") return oneLiner;

  let i = 2;
  let firstLine = "docker run";
  // Boolean short flags (e.g. -d) right after `run` stay on line 1: a flag is
  // boolean when the next token is another flag or there is no next token.
  while (
    i < tokens.length &&
    /^-[a-zA-Z]$/.test(tokens[i]) &&
    (i + 1 >= tokens.length || tokens[i + 1].startsWith("-"))
  ) {
    firstLine += " " + tokens[i];
    i++;
  }

  const groups: string[] = [firstLine];
  while (i < tokens.length) {
    const t = tokens[i];
    if (t.startsWith("-") && i + 1 < tokens.length && !tokens[i + 1].startsWith("-")) {
      groups.push(`${t} ${tokens[i + 1]}`); // value flag + its value
      i += 2;
    } else {
      groups.push(t); // boolean flag or bare token (image)
      i += 1;
    }
  }
  return groups.join(" \\\n  ");
}

// Pretty-prints a compound shell one-liner (multiple commands joined by `&&`,
// `||`, or `;`) into one step per line, with each `docker run` step's flags
// expanded via formatDockerRun. Steps containing a quoted argument (e.g. the
// guacd `-c '… | tee …'` wrapper) are left as a single line — the naive flag
// tokenizer can't preserve quoted whitespace. Pure + display-only; callers copy
// the original one-liner, never this. A separator sequence never appears inside
// our generated commands' quotes, so the split is safe for them.
export function formatShellCommand(oneLiner: string): string {
  const trimmed = oneLiner.trim();
  if (trimmed === "") return oneLiner;
  // Capturing split keeps separators: [cmd, sep, cmd, sep, …]. `;` needs no
  // leading space (our commands emit `… 2>&1; docker run …`).
  const parts = trimmed.split(/(\s+&&\s+|\s+\|\|\s+|;\s+)/);
  const lines: string[] = [];
  for (let i = 0; i < parts.length; i += 2) {
    const cmd = parts[i]?.trim();
    if (!cmd) continue;
    const sep = parts[i + 1]?.trim() ?? ""; // "&&" | "||" | ";" | ""
    const formatted = cmd.startsWith("docker run") && !cmd.includes("'") ? formatDockerRun(cmd) : cmd;
    lines.push(sep ? `${formatted} ${sep}` : formatted);
  }
  return lines.join("\n");
}
