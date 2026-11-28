import { copyServes, type Stream } from "./holders";
import { silentFor } from "./unreachable";

/**
 * What the recording page says about where the recording is, when that is
 * worth saying: its connector is offline (and whether a copy plays instead),
 * or it is playing from a copy that is not whole yet.
 */
export type HolderInfo = { name: string; online: boolean; lastSeenAt: Date | null };
export type CopyInfo = HolderInfo & { complete: boolean };

/** The stream the player asks for first. */
export function mainStreamOf(rec: { format: string; videoReady: boolean }): Stream {
  if (rec.format === "RRWEB") return "rrweb";
  if (rec.format === "TERM") return "term";
  if (rec.format === "VIDEO" || ((rec.format === "GUAC" || rec.format === "RDP") && rec.videoReady)) return "video";
  return rec.format === "RDP" ? "rdp" : "guac";
}

export type HolderNotice =
  | { kind: "none" }
  /** The original is offline and nothing else can play it. `copiesElsewhere`: copies exist but are offline or cannot serve. */
  | { kind: "offline"; original: string; since: string; copiesElsewhere: string[] }
  /** The original is offline; this is playing from a copy. */
  | { kind: "from_copy"; original: string; since: string; copy: string; complete: boolean };

export function holderNotice(
  rec: { format: string; videoReady: boolean; protocol: string | null },
  original: HolderInfo | null,
  copies: CopyInfo[],
  now: Date,
): HolderNotice {
  if (!original || original.online) return { kind: "none" };
  const stream = mainStreamOf(rec);
  const serving = copies.filter((c) => copyServes(rec, stream, c.complete));
  const live = serving.filter((c) => c.online).sort((a, b) => Number(b.complete) - Number(a.complete))[0];
  const since = silentFor(original.lastSeenAt, now);
  if (live) return { kind: "from_copy", original: original.name, since, copy: live.name, complete: live.complete };
  return { kind: "offline", original: original.name, since, copiesElsewhere: serving.map((c) => c.name) };
}
