// Updates and removal of a connector's host from the console. The console asks
// the data-plane, which asks the connector, which hands the request to the
// updater beside it (updater/main.go): the one container on the host with
// Docker access. A request names an action and a version, nothing more.
//
// Pure and client-safe; the call to the data-plane is in host-action-send.ts.
import { compareSemver } from "@/lib/updates/semver";
import type { ConnectorTelemetry, HostActionState, HostActionStatus } from "@/lib/connector/telemetry";

/** What Connector.hostAction holds: the latest request and how it went. */
export interface StoredHostAction {
  id: string;
  action: "update" | "uninstall";
  version?: string;
  keepData?: boolean;
  waitIdle?: boolean;
  by: string;
  at: string;
  /** Last state seen in telemetry; "sent" until the connector reports one. */
  state: HostActionState | "sent" | "cancelled";
  detail?: string;
  from?: string;
}

export const FINAL_STATES: readonly string[] = ["done", "rolled_back", "failed", "cancelled"];

export function newHostActionId(): string {
  const b = globalThis.crypto.getRandomValues(new Uint8Array(12));
  return `act_${Buffer.from(b).toString("base64url")}`;
}

export function storedHostAction(v: unknown): StoredHostAction | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Partial<StoredHostAction>;
  return typeof o.id === "string" && (o.action === "update" || o.action === "uninstall") ? (o as StoredHostAction) : null;
}

export type RemoteControl =
  | { ok: true; updaterVersion: string }
  | { ok: false; reason: "offline" | "no_updater" | "no_docker" | "installing" | "program" };

/**
 * How long after pairing a connector without an updater counts as still being
 * installed: the install command starts the updater last, after the session
 * engines' images (the isolated browser's is over a gigabyte) have downloaded.
 */
export const UPDATER_INSTALL_GRACE_MS = 20 * 60_000;

/**
 * Whether the console can update or remove this connector right now. The
 * connector reports an updater only while the updater's heartbeat is fresh, and
 * only connectors from 2.41.0 report one at all.
 */
export function remoteControl(online: boolean, t: ConnectorTelemetry | null | undefined, pairedAt?: Date | string | null, now = Date.now(), platform?: string | null): RemoteControl {
  if (!online || !t) return { ok: false, reason: "offline" };
  // Installed as a program: no updater and no Docker, updated by `connector update` on its host.
  if (platform) return { ok: false, reason: "program" };
  if (!t.updater) {
    const paired = pairedAt ? new Date(pairedAt).getTime() : NaN;
    return { ok: false, reason: now - paired < UPDATER_INSTALL_GRACE_MS ? "installing" : "no_updater" };
  }
  if (!t.updater.dockerOk) return { ok: false, reason: "no_docker" };
  return { ok: true, updaterVersion: t.updater.version };
}

/** A host action still under way: the console offers nothing new until it ends. */
export function hostActionBusy(s: HostActionStatus | null | undefined): boolean {
  return !!s && !FINAL_STATES.includes(s.state);
}

/** The update the console offers: the manager's own version, when it is newer. */
export function updateTarget(connectorVersion: string | null | undefined, managerVersion: string): string | null {
  return /^\d+\.\d+\.\d+$/.test(managerVersion) && compareSemver(connectorVersion, managerVersion) === -1 ? managerVersion : null;
}

/**
 * Folds the connector's report into the stored request. Returns the new value
 * when something changed (and the event to note, when the action ended), null
 * when nothing did. A report for another id is an older request: ignored.
 */
export function foldHostAction(stored: StoredHostAction | null, report: HostActionStatus | null | undefined):
  { next: StoredHostAction; event: { level: "ok" | "warn" | "bad" | "info"; text: string } | null } | null {
  if (!stored || !report || report.id !== stored.id || FINAL_STATES.includes(stored.state)) return null;
  if (report.state === stored.state && (report.detail ?? "") === (stored.detail ?? "")) return null;
  const next: StoredHostAction = { ...stored, state: report.state, detail: report.detail || undefined, from: report.from || stored.from };
  const v = stored.version ?? report.version ?? "";
  let event: { level: "ok" | "warn" | "bad" | "info"; text: string } | null = null;
  if (report.state === "done") event = { level: "ok", text: `Updated from the console to ${v}` };
  else if (report.state === "rolled_back") event = { level: "warn", text: `Update to ${v} rolled back: ${report.detail || "the new version did not connect"}` };
  else if (report.state === "failed") event = { level: "bad", text: `Update to ${v} failed: ${report.detail || "no reason given"}` };
  return { next, event };
}

const REASONS: Record<string, string> = {
  offline: "The connector is offline.",
  no_updater: "This connector has no updater. Run the update command on its host once; it installs one.",
  no_hostctl: "This connector has no updater. Run the update command on its host once; it installs one.",
  no_answer: "The connector did not answer. Try again in a minute.",
  not_ready: "The connector is still connecting. Try again in a minute.",
  busy: "The connector's host is already busy with an update.",
  not_pending: "There is no waiting update to cancel; it may have started already.",
  write_failed: "The connector could not hand the request to its updater.",
  invalid: "The connector refused the request.",
  invalid_body: "The connector refused the request.",
};

export function hostActionError(reason: string | undefined): string {
  return (reason && REASONS[reason]) || "The connector could not take the request.";
}

/** How long a just-sent request may go unreported before the console stops assuming it is under way. */
const SENT_GRACE_MS = 3 * 60_000;

/**
 * The host action to show. The connector reports a new request with its next
 * telemetry (up to 10 s later); until then the stored request stands in for it,
 * so the page right after "Update now" shows the update rather than the old
 * "new version" band.
 */
export function liveHostAction(report: HostActionStatus | null, stored: StoredHostAction | null, now: Date): HostActionStatus | null {
  if (report && (!stored || report.id === stored.id || FINAL_STATES.includes(stored.state))) return report;
  if (stored && stored.action === "update" && stored.state === "sent" && now.getTime() - Date.parse(stored.at) < SENT_GRACE_MS) {
    return { id: stored.id, action: "update", state: stored.waitIdle ? "waiting_idle" : "preparing", version: stored.version, from: stored.from, at: stored.at };
  }
  return report;
}
