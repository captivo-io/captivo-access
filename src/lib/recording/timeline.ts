// The player page's event list and seek-bar markers (design hand-off 7.10),
// built only from what is recorded: the session's start and end, typed input
// (commands and text, password prompts hidden), file transfers from the audit
// log, and a web app's page loads. Nothing is inferred.

export type TimelineTone = "muted" | "nav" | "file" | "command" | "text";

export interface TimelineEvent {
  atMs: number;
  tone: TimelineTone;
  text: string;
  /** Typed into a terminal: shown with a "$ " prompt. */
  command?: boolean;
}

export function buildTimeline(input: {
  totalMs: number;
  keys?: { atMs: number; kind: string; text: string; masked: boolean }[];
  transfers?: { atMs: number; text: string }[];
  navs?: { atMs: number; text: string }[];
  /** Moments a recorded native SSH session marked (sshrec_term.go): refusals, SFTP changes, commands run without a terminal. */
  marks?: { atMs: number; text: string }[];
  terminal: boolean;
}): TimelineEvent[] {
  const out: TimelineEvent[] = [{ atMs: 0, tone: "muted", text: "Session started" }];
  for (const k of input.keys ?? []) {
    const text = k.masked ? "Hidden input (password prompt)" : k.text.trim();
    if (!text) continue;
    const command = input.terminal && k.kind === "command" && !k.masked;
    out.push({ atMs: k.atMs, tone: command ? "command" : "text", text, ...(command ? { command } : {}) });
  }
  for (const t of input.transfers ?? []) out.push({ atMs: t.atMs, tone: "file", text: t.text });
  for (const n of input.navs ?? []) out.push({ atMs: n.atMs, tone: "nav", text: `Opened ${n.text}` });
  const typed = new Set((input.keys ?? []).map((k) => k.text.trim()));
  for (const m of input.marks ?? []) {
    // Transfers come from the audit log above; a command also logged as typed input is listed once.
    if (/^(Uploaded|Downloaded) /.test(m.text)) continue;
    if (m.text.startsWith("$ ")) {
      const cmd = m.text.slice(2).trim();
      if (!typed.has(cmd)) out.push({ atMs: m.atMs, tone: "command", text: cmd, command: true });
      continue;
    }
    out.push({ atMs: m.atMs, tone: /refused/i.test(m.text) ? "text" : /^SFTP|File transfer/.test(m.text) ? "file" : "muted", text: m.text });
  }
  // Clamp into the recording and keep a stable order for equal times.
  const body = out.slice(1).map((e) => ({ ...e, atMs: Math.max(0, Math.min(e.atMs, input.totalMs || e.atMs)) }));
  body.sort((a, b) => a.atMs - b.atMs);
  const all = [out[0], ...body];
  if (input.totalMs > 0) all.push({ atMs: input.totalMs, tone: "muted", text: "Session ended" });
  return all;
}

/** The event the playhead is on: the last one at or before it. */
export function currentEventIndex(events: TimelineEvent[], positionMs: number): number {
  let at = -1;
  for (let i = 0; i < events.length; i++) {
    if (events[i].atMs <= positionMs + 250) at = i;
    else break;
  }
  return at;
}
