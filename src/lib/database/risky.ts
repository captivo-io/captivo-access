// Statements worth a second look in a database session's log: they drop or
// empty data, change every row, or change who may do what. A marker for the
// reader, not a control: what a session can do is what its account can do.

const RULES: [RegExp, string][] = [
  [/^\s*drop\s+(table|database|schema|index|view|function|role|user)\b/i, "Drops an object"],
  [/^\s*truncate\b/i, "Empties a table"],
  [/^\s*delete\s+from\s+[^;]*$/i, ""], // decided below: only without WHERE
  [/^\s*update\s+[^;]*$/i, ""],
  [/^\s*alter\s+(table|database|role|user|system)\b/i, "Changes the schema or a role"],
  [/^\s*(grant|revoke)\b/i, "Changes permissions"],
  [/^\s*(create|alter)\s+(role|user)\b/i, "Creates or changes a role"],
  [/^\s*copy\s+[^;]*\bto\s+program\b/i, "Runs a program on the server"],
  [/\binto\s+(outfile|dumpfile)\b/i, "Writes a file on the server"],
  // SQL Server
  [/^\s*(create|alter|drop)\s+login\b/i, "Creates or changes a login"],
  [/\bxp_cmdshell\b/i, "Runs a program on the server"],
  [/\b(openrowset|opendatasource)\s*\(|^\s*bulk\s+insert\b/i, "Reads files or other servers"],
  [/\bsp_configure\b|^\s*reconfigure\b/i, "Changes the server's configuration"],
];

/** Why a statement is risky, or null. Comments at the start are skipped. */
export function riskyReason(sql: string): string | null {
  const s = sql.replace(/^(\s*(--[^\n]*\n|\/\*[\s\S]*?\*\/))+/, "").trim().replace(/[\s;]+$/, "");
  for (const [re, why] of RULES) {
    if (!re.test(s)) continue;
    if (/^\s*(delete|update)\b/i.test(s)) {
      if (/\bwhere\b/i.test(s)) continue;
      return /^\s*delete/i.test(s) ? "Deletes every row" : "Changes every row";
    }
    return why;
  }
  return null;
}
