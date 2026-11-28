// What a group's copies amount to, for the Connectors page.

export type ReplicaRow = { state: string; lastError: string | null; _count: number; bytes: number };

export type ReplicaSummary = {
  complete: number;
  copying: number;
  /** Plaintext bytes of the copies held (before each connector compresses its own). */
  bytes: number;
  /** Why some copies are not moving, by short code, with how many. */
  stalled: { code: string; count: number }[];
};

export function summarizeReplicas(rows: ReplicaRow[]): ReplicaSummary {
  const out: ReplicaSummary = { complete: 0, copying: 0, bytes: 0, stalled: [] };
  const stalled = new Map<string, number>();
  for (const r of rows) {
    if (r.state === "COMPLETE") out.complete += r._count;
    else out.copying += r._count;
    out.bytes += r.bytes;
    if (r.lastError && r.state !== "COMPLETE") stalled.set(r.lastError, (stalled.get(r.lastError) ?? 0) + r._count);
  }
  out.stalled = [...stalled.entries()].map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count);
  return out;
}

/** The sentence for a stalled code. Unknown codes are not shown raw. */
export function stalledText(code: string, count: number): string {
  const n = count === 1 ? "1 recording" : `${count} recordings`;
  switch (code) {
    case "waiting_for_video": return `${n}: a remote-desktop session is copied as video, which its connector is still making`;
    case "origin_unreachable": return `${n}: the connector holding the original did not answer`;
    case "target_unreachable": return `${n}: this connector did not answer`;
    case "copy_failed": return `${n}: the last copy attempt failed; it is retried`;
    case "diverged": return `${n}: the original was rewritten after it was copied (a video made again); the copy is kept as it was`;
    case "origin_empty": return `${n}: the original holds nothing yet`;
    default: return `${n}: not moving`;
  }
}
