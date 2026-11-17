// The typed-input stream of a recording, as /api/admin/recordings/:id/keyevents
// returns it: gateway (SSH commands, RDP/VNC text), web app (field values) and
// isolated browser. The player page lists it with the session's other events.
export type KeystrokeEvent = { atMs: number; kind: string; text: string; masked: boolean };

export function fmtMs(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}
