// Parses the raw log tails a connector reports (its own log, guacd and the
// KasmVNC broker, each in its own format) into time / level / message, and
// folds runs of identical lines so a retry loop reads as one row with "×n".

export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";
export interface LogLine { time: string; level: LogLevel; msg: string }
export interface LogRow extends LogLine { count: number }
export type LevelFilter = "all" | "warn" | "error";

// "2026/11/18 12:00:01", "2026-11-18T12:00:01.123Z", "2026-11-18 12:00:01,123", "[12:00:01]"
const TS = /^\s*\[?(?:\d{4}[-/]\d{2}[-/]\d{2}[T ])?(\d{2}:\d{2}:\d{2})(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?\]?\s*/;
const LEVEL = /[[(<]?\b(TRACE|DEBUG|INFO|NOTICE|WARNING|WARN|ERROR|ERR|FATAL|CRITICAL|CRIT|PANIC)\b[\])>]?:?\s*/i;

const LEVEL_OF: Record<string, LogLevel> = {
  TRACE: "DEBUG", DEBUG: "DEBUG", INFO: "INFO", NOTICE: "INFO", WARN: "WARN", WARNING: "WARN",
  ERR: "ERROR", ERROR: "ERROR", FATAL: "ERROR", CRIT: "ERROR", CRITICAL: "ERROR", PANIC: "ERROR",
};

export function parseLogLine(raw: string): LogLine {
  let rest = raw.replace(/\r$/, "");
  let time = "";
  const ts = TS.exec(rest);
  if (ts) { time = ts[1]; rest = rest.slice(ts[0].length); }
  // The level sits near the front ("INFO …", "guacd[7]: ERROR:\t…", "[WARN] …");
  // a word like "error" deep inside a message is not the line's level.
  const lv = LEVEL.exec(rest);
  let level: LogLevel = "INFO";
  if (lv && lv.index <= 24) {
    level = LEVEL_OF[lv[1].toUpperCase()];
    rest = (rest.slice(0, lv.index) + rest.slice(lv.index + lv[0].length));
  }
  return { time, level, msg: rest.replace(/\t/g, " ").trim() };
}

/** Consecutive lines with the same level and message become one row; it keeps the newest time. */
export function collapseLines(lines: LogLine[]): LogRow[] {
  const out: LogRow[] = [];
  for (const l of lines) {
    const prev = out[out.length - 1];
    if (prev && prev.level === l.level && prev.msg === l.msg) {
      prev.count++;
      if (l.time) prev.time = l.time;
    } else out.push({ ...l, count: 1 });
  }
  return out;
}

export function levelPasses(level: LogLevel, f: LevelFilter): boolean {
  return f === "all" || (f === "error" ? level === "ERROR" : level === "WARN" || level === "ERROR");
}

/** Parse, filter by level and text, then fold repeats (folding after filtering, so a filter can't hide what was folded). */
export function logRows(raw: string[], f: LevelFilter, q: string): LogRow[] {
  const t = q.trim().toLowerCase();
  return collapseLines(raw.map(parseLogLine).filter((l) => levelPasses(l.level, f) && (!t || l.msg.toLowerCase().includes(t))));
}
