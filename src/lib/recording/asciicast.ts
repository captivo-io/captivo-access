// A recorded native SSH session (format TERM) is asciicast v2: a header line,
// then [seconds, code, data] events, "o" for what the terminal showed, "r" for
// a resize ("120x40") and "m" for a moment the recorder marked (a command run
// without a terminal, a file transfer, something refused). Written by
// dataplane/sshrec_term.go. Pure, so the player and its tests share it.

export interface TermEvent { atMs: number; code: "o" | "r" | "m"; data: string }
export interface TermRecording { cols: number; rows: number; events: TermEvent[]; lengthMs: number }

export function parseAsciicast(text: string): TermRecording {
  let cols = 80, rows = 24, header = false;
  const events: TermEvent[] = [];
  for (const line of text.split("\n")) {
    const l = line.trim();
    if (!l) continue;
    let v: unknown;
    try {
      v = JSON.parse(l);
    } catch {
      continue; // a line cut short by a session that ended mid-write
    }
    if (!header && v && typeof v === "object" && !Array.isArray(v)) {
      const h = v as { width?: unknown; height?: unknown };
      if (typeof h.width === "number" && h.width > 0) cols = h.width;
      if (typeof h.height === "number" && h.height > 0) rows = h.height;
      header = true;
      continue;
    }
    if (!Array.isArray(v) || v.length < 3 || typeof v[0] !== "number" || typeof v[2] !== "string") continue;
    const code = v[1];
    if (code !== "o" && code !== "r" && code !== "m") continue;
    events.push({ atMs: Math.max(0, Math.round(v[0] * 1000)), code, data: v[2] });
  }
  events.sort((a, b) => a.atMs - b.atMs);
  return { cols, rows, events, lengthMs: events.length ? events[events.length - 1].atMs : 0 };
}

/** "120x40" to [120, 40]; null when it isn't a size. */
export function parseSize(s: string): [number, number] | null {
  const m = /^(\d{1,4})x(\d{1,4})$/.exec(s.trim());
  if (!m) return null;
  const c = Number(m[1]), r = Number(m[2]);
  return c > 0 && r > 0 ? [c, r] : null;
}

/**
 * What the terminal shows at `ms`: its size then, and the output so far to
 * write into a cleared terminal. Seeking replays from the start, which is
 * how a terminal's state can be known.
 */
export function stateAt(rec: TermRecording, ms: number): { cols: number; rows: number; output: string; next: number } {
  let cols = rec.cols, rows = rec.rows;
  const parts: string[] = [];
  let i = 0;
  for (; i < rec.events.length && rec.events[i].atMs <= ms; i++) {
    const e = rec.events[i];
    if (e.code === "o") parts.push(e.data);
    else if (e.code === "r") {
      const s = parseSize(e.data);
      if (s) [cols, rows] = s;
    }
  }
  return { cols, rows, output: parts.join(""), next: i };
}

/** Marked moments, for the events list and the seek bar. */
export function termMarks(rec: TermRecording): { atMs: number; text: string }[] {
  return rec.events.filter((e) => e.code === "m" && e.data !== "Session ended").map((e) => ({ atMs: e.atMs, text: e.data }));
}

/** Where playback goes next: past a quiet stretch longer than idleMs, to just before the next output. */
export function skipIdle(rec: TermRecording, from: number, pos: number, idleMs: number): number {
  const next = rec.events[from];
  if (!next) return pos;
  return next.atMs - pos > idleMs ? next.atMs - 500 : pos;
}
