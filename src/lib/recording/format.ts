// Pure formatting for recordings, shared by the server pages and the client views.

export interface RecordingLike {
  id: string;
  format: string;
  protocol: string | null;
  videoReady?: boolean;
}

/** The badge on a thumbnail and in the player header. */
export function protocolLabel(r: { format: string; protocol: string | null }): string {
  if (r.format === "RRWEB") return "WEB";
  if (r.format === "VIDEO") return "BROWSER";
  if (r.format === "SQL") return r.protocol === "kubernetes" ? "K8S" : "SQL";
  if (r.format === "TERM") return r.protocol === "kubernetes" ? "KUBECTL" : "SSH";
  return (r.protocol ?? "rdp").toUpperCase();
}

/** Only video leaves the console as a file anyone can play; the other formats are replay streams. */
export const downloadable = (r: RecordingLike) => r.format === "VIDEO" || ((r.format === "GUAC" || r.format === "RDP") && !!r.videoReady);

/** "4:10", or "1:02:07" past an hour. */
export function clockOf(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
}

/** "8 min 40 s", "2 h 5 min". */
export function spanOf(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (h) return `${h} h ${m} min`;
  if (m) return `${m} min ${sec} s`;
  return `${sec} s`;
}

export function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export const initials = (s: string) => (s.split(/[\s@.]+/).filter(Boolean).map((w) => w[0]).slice(0, 2).join("") || "?").toUpperCase();

export function fileNameFor(resource: string, startedAt: string): string {
  const safe = resource.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "recording";
  return `${safe}-${startedAt.slice(0, 16).replace(/[:T]/g, "-")}.webm`;
}
