import { compareSemver, isConnectorOutdated } from "./semver";

// What the Updates page says about the running version and the connectors.
// Pure + db-free so it unit-tests.

/** current: same as the latest release; ahead: newer than it; behind: an update exists; unknown: never checked or not a plain version. */
export type UpdateStatus = "current" | "ahead" | "behind" | "unknown";

export function updateStatus(running: string, latest: string | null | undefined): UpdateStatus {
  const c = compareSemver(running, latest);
  if (c === null) return "unknown";
  return c === 0 ? "current" : c > 0 ? "ahead" : "behind";
}

/** The page checks by itself at most this often. */
export const CHECK_STALE_MS = 24 * 60 * 60 * 1000;

/** Whether opening the page should run a check: checks on, and none in the last day. */
export function checkIsStale(enabled: boolean, lastCheckedAt: string | null, now: number): boolean {
  if (!enabled) return false;
  if (!lastCheckedAt) return true;
  const t = Date.parse(lastCheckedAt);
  return Number.isNaN(t) || now - t >= CHECK_STALE_MS;
}

export type ConnectorVersionState = "current" | "outdated" | "unknown";

/** The Connectors page's rule: outdated when older than the last connector change (semver.ts). */
export function connectorVersionState(version: string | null | undefined, manager: string): ConnectorVersionState {
  if (compareSemver(version, manager) === null) return "unknown";
  return isConnectorOutdated(version, manager) ? "outdated" : "current";
}
