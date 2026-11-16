/**
 * The most one Range answer for a recording video carries. A connector sends a
 * range back as ONE tunnel frame, and frames are capped at 1 MiB
 * (tunnel/frame.go): a larger range came back as a 206 with an empty body, so a
 * video played its first seconds from the initial request and then stalled on
 * every later one ("loading", back to Play, restart from zero). Answering at most
 * this much is standard for a media server -- the browser asks again from where
 * the answer ended -- and works with every connector already deployed.
 * Connectors from 2.14.2 also split a large range into frames.
 */
export const MAX_RANGE_BYTES = 1 << 20;

/**
 * "bytes=START-END", either side optionally empty, clamped to MAX_RANGE_BYTES.
 * A suffix range ("bytes=-500") is not supported: the connector addresses from
 * the start, and refusing is honest where guessing would serve the wrong bytes.
 * toByte 0 with wantsRange false means "the whole recording".
 */
export function parseVideoRange(header: string | null): { wantsRange: boolean; fromByte: number; toByte: number } {
  const m = header ? /^bytes=(\d*)-(\d*)$/.exec(header.trim()) : null;
  const wantsRange = !!m && m[1] !== "";
  if (!m || !wantsRange) return { wantsRange: false, fromByte: 0, toByte: 0 };
  const fromByte = parseInt(m[1], 10);
  const askedTo = m[2] ? parseInt(m[2], 10) : Number.POSITIVE_INFINITY;
  if (askedTo < fromByte) return { wantsRange: false, fromByte: 0, toByte: 0 };
  return { wantsRange: true, fromByte, toByte: Math.min(askedTo, fromByte + MAX_RANGE_BYTES - 1) };
}
