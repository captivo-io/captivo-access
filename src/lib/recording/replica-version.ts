import { compareSemver } from "@/lib/updates/semver";

/** The first connector release that can hold a copy of a recording (and be copied from). */
export const REPLICA_MIN_VERSION = "2.84.0";

/** Whether a connector at this version can take part in recording copies. Unknown versions are not assumed to. */
export function canHoldCopies(version: string | null | undefined): boolean {
  const c = compareSemver(version, REPLICA_MIN_VERSION);
  return c !== null && c >= 0;
}
