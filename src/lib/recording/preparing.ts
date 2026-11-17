import { compareSemver } from "@/lib/updates/semver";

/** The first connector release that turns RDP/VNC recordings into video. */
export const VIDEO_CONVERSION_SINCE = "2.21.0";

/**
 * Whether an RDP/VNC recording's video is still being made on its connector:
 * it has not been reported on yet, and its connector is one that makes videos.
 * Once reported it is settled either way (a video, or kept as it is), and an
 * older connector never makes one, so neither shows "preparing".
 */
export function videoPreparing(
  rec: { format: string; protocol: string | null; videoReady: boolean; reportedAt: Date | null },
  connectorVersion: string | null | undefined,
): boolean {
  if (rec.format !== "GUAC" || rec.videoReady || rec.reportedAt) return false;
  const p = (rec.protocol ?? "").toLowerCase();
  if (p !== "rdp" && p !== "vnc") return false;
  const cmp = compareSemver(connectorVersion, VIDEO_CONVERSION_SINCE);
  return cmp !== null && cmp >= 0;
}
