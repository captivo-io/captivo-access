"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Modal } from "@/app/(app)/_shell/modal";
import { CommandBlock } from "@/app/(app)/_shell/command-block";
import { formatShellCommand } from "@/lib/format/docker-command";
import type { HostActionStatus } from "@/lib/connector/telemetry";
import { hostActionError, type RemoteControl } from "@/lib/connector/host-action";

/** The update command with and without the updater (see buildConnectorUpdateCommand). */
export type UpdateCommands = { remote: string; manual: string };

/** The install/update/re-pair commands' opt-out: no container with Docker access on the host. */
export function UpdaterChoice({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  return (
    <label className="cn-upd-opt">
      <input type="checkbox" checked={on} onChange={(e) => onChange(e.target.checked)} />
      <span>
        <b>Allow updates and removal from this console</b>
        <span>
          Adds a small updater container with access to Docker on the host. It takes no commands from the network and can only
          install Captivo releases. Turn it off if your policy forbids that; you then run each update on the host yourself.
        </span>
      </span>
    </label>
  );
}

const NO_REMOTE: Record<string, string> = {
  no_updater: "Updates from the console need the updater beside the connector. This command installs it along with the update; after that, an update is one click here.",
  no_docker: "The updater on this host can't reach Docker (a rootless Docker, or a socket somewhere other than /var/run/docker.sock?). Run the update on the host instead.",
  offline: "It is offline, so the console can't update it.",
};

/**
 * "Update now": through the updater when the host has one, otherwise the
 * command to run on the host (which installs the updater, unless turned off).
 */
export function UpdateConnectorButton({
  connectorId, commands, managerUrlIsLocal, remote, target, from, openTunnels, label = "Update", className = "btn sm",
}: {
  connectorId: string;
  commands: UpdateCommands;
  managerUrlIsLocal: boolean;
  remote: RemoteControl | null;
  target: string | null;
  from: string | null;
  openTunnels: number;
  label?: string;
  className?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [when, setWhen] = useState<"now" | "idle">("now");
  const [withUpdater, setWithUpdater] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const viaConsole = !!remote?.ok && !!target;
  const command = withUpdater ? commands.remote : commands.manual;

  async function go() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/connectors/${connectorId}/host-action`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "update", waitIdle: when === "idle" }),
      });
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !j.ok) {
        setError(j.error === "up_to_date" ? "The connector already runs this version." : hostActionError(j.error));
        return;
      }
      setOpen(false);
      router.refresh();
    } catch {
      setError(hostActionError(undefined));
    } finally {
      setBusy(false);
    }
  }

  const manual = (
    <>
      <CommandBlock command={command} display={formatShellCommand(command)} title="connector-update" />
      {managerUrlIsLocal && (
        <p className="notice error" style={{ marginBottom: 0 }}>
          <code>MANAGER_URL</code> points at <code>localhost</code> — replace it with the manager&apos;s
          real address (set <code>MANAGER_PUBLIC_URL</code> in the server&apos;s <code>.env</code>).
        </p>
      )}
    </>
  );

  return (
    <>
      <button type="button" className={className} onClick={() => { setError(null); setOpen(true); }}>{label}</button>
      <Modal open={open} onClose={() => setOpen(false)} title={viaConsole ? `Update to ${target}` : "Update connector"}>
        {viaConsole ? (
          <>
            <p className="cell-sub" style={{ marginTop: 0 }}>
              The updater on the connector&apos;s host downloads {target}, replaces the containers and checks that the connector connects again.
              If it doesn&apos;t within 4 minutes, the updater goes back to {from ?? "the current version"} by itself. The token, the pairing,
              the recordings and the keys stay as they are.
            </p>
            <div className="seg cn-upd-when" role="radiogroup" aria-label="When">
              <button type="button" role="radio" aria-checked={when === "now"} className={when === "now" ? "seg-opt on" : "seg-opt"} onClick={() => setWhen("now")}>Now</button>
              <button type="button" role="radio" aria-checked={when === "idle"} className={when === "idle" ? "seg-opt on" : "seg-opt"} onClick={() => setWhen("idle")}>When nobody is connected</button>
            </div>
            <p className={when === "now" && openTunnels > 0 ? "cn-upd-sub warn" : "cn-upd-sub"}>
              {when === "idle"
                ? "Starts once no tunnel has been open for 30 seconds. You can cancel it until then."
                : openTunnels > 0
                  ? `${openTunnels} open tunnel${openTunnels === 1 ? "" : "s"} end. Sessions on this connector drop for about a minute.`
                  : "Nobody is connected through it right now."}
            </p>
            {error && <p className="notice error" role="alert">{error}</p>}
            <div className="row-actions">
              <button type="button" className="btn sm" disabled={busy} onClick={() => setOpen(false)}>Cancel</button>
              <button type="button" className="btn sm primary" disabled={busy} onClick={() => void go()}>{busy ? "Sending…" : when === "idle" ? "Update when idle" : `Update to ${target}`}</button>
            </div>
            <details className="cn-upd-manual">
              <summary>Or run it on the host yourself</summary>
              {manual}
            </details>
          </>
        ) : (
          <>
            <p className="cell-sub" style={{ marginTop: 0 }}>
              Run this on the connector&apos;s host. It keeps the connector&apos;s token, so no re-pairing.
              {remote && !remote.ok && NO_REMOTE[remote.reason] ? <> {NO_REMOTE[remote.reason]}</> : null}
            </p>
            <UpdaterChoice on={withUpdater} onChange={setWithUpdater} />
            {manual}
            <div className="row-actions">
              <button type="button" className="btn sm" onClick={() => setOpen(false)}>Close</button>
            </div>
          </>
        )}
      </Modal>
    </>
  );
}

/**
 * An up-to-date connector the console still can't update: no updater beside it
 * (installed or last updated with a command from before 2.41.0, or with the
 * updater turned off), or one that can't reach Docker. Without this band such a
 * connector shows no way to get the command at all until the next release.
 */
export function NoUpdaterBand({ connectorId, commands, managerUrlIsLocal, remote, version }: {
  connectorId: string;
  commands: UpdateCommands;
  managerUrlIsLocal: boolean;
  remote: RemoteControl;
  version: string | null;
}) {
  if (remote.ok || remote.reason === "offline") return null;
  return (
    <div className="cn-band info">
      <span className="cn-band-t">
        {remote.reason === "no_docker"
          ? "Updates from the console are off: the updater on this host can't reach Docker."
          : "Updates from the console are off: this connector has no updater. Run the update command on its host once to add it."}
      </span>
      <UpdateConnectorButton connectorId={connectorId} commands={commands} managerUrlIsLocal={managerUrlIsLocal} remote={remote} target={null}
        from={version} openTunnels={0} label="Show command" className="btn sm" />
    </div>
  );
}

const STATE_TEXT: Record<string, (v: string, s: HostActionStatus) => string> = {
  waiting_idle: (v) => `Update to ${v} waits until nobody is connected.`,
  preparing: (v) => `Updating to ${v}: downloading.`,
  applying: (v) => `Updating to ${v}: replacing the containers and waiting for the new version to connect.`,
  rolling_back: (v, s) => `${v} did not connect; going back to ${s.from || "the previous version"}.`,
  done: (v) => `Updated to ${v} from the console.`,
  rolled_back: (v, s) => `Update to ${v} was rolled back${s.detail ? `: ${s.detail}` : ""}. The connector runs ${s.from || "its previous version"} again.`,
  failed: (v, s) => `Update to ${v} failed${s.detail ? `: ${s.detail}` : ""}.`,
};

/** How long a finished update stays on the page. */
const SHOW_FINISHED_MS = 30 * 60_000;

/** Progress of an update asked from the console, as the connector reports it. */
export function HostActionBand({ connectorId, status, now, outdated = false }: { connectorId: string; status: HostActionStatus | null | undefined; now: number; outdated?: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!status || status.action !== "update" || !STATE_TEXT[status.state]) return null;
  const finished = status.state === "done" || status.state === "rolled_back" || status.state === "failed";
  if (finished && status.at && now - Date.parse(status.at) > SHOW_FINISHED_MS) return null;
  // "Updated to X" next to "a new version is ready" says two things at once;
  // once a newer release is out, the success is old news. A rollback or a
  // failure still matters then, so those stay.
  if (status.state === "done" && outdated) return null;
  const tone = status.state === "done" ? "ok" : status.state === "failed" ? "bad" : status.state === "rolled_back" ? "warn" : "info";

  async function cancel() {
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/admin/connectors/${connectorId}/host-action`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "cancel" }),
    }).catch(() => null);
    const j = (await res?.json().catch(() => ({}))) as { ok?: boolean; error?: string } | undefined;
    setBusy(false);
    if (res?.ok && j?.ok) router.refresh();
    else setError(hostActionError(j?.error));
  }

  return (
    <div className={`cn-band ${tone}`} role="status">
      {!finished && <span className="rs-spin" aria-hidden="true" />}
      <span className="cn-band-t">{STATE_TEXT[status.state](status.version ?? "", status)}{error && <span className="t-bad"> {error}</span>}</span>
      {status.state === "waiting_idle" && <button type="button" className="btn sm" disabled={busy} onClick={() => void cancel()}>{busy ? "Cancelling…" : "Cancel"}</button>}
    </div>
  );
}

/**
 * Takes the connector off its host through the updater, then revokes it. The
 * recordings and the keys that open them stay on the host unless asked.
 */
export function RemoveFromHostModal({ open, onClose, id, name, resources, remote }: {
  open: boolean;
  onClose: () => void;
  id: string;
  name: string;
  resources: number;
  remote: RemoteControl | null;
}) {
  const router = useRouter();
  const [typed, setTyped] = useState("");
  const [wipe, setWipe] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const can = !!remote?.ok;

  function close() {
    setTyped("");
    setWipe(false);
    setError(null);
    onClose();
  }

  async function go() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/connectors/${id}/host-action`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "uninstall", keepData: !wipe, confirmName: typed }),
      });
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !j.ok) {
        setError(j.error === "confirm_mismatch" ? "Type the connector's name exactly." : hostActionError(j.error));
        return;
      }
      close();
      router.refresh();
    } catch {
      setError(hostActionError(undefined));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={close} title={`Remove "${name}" from its host?`} size="md">
      {can ? (
        <>
          <p className="cell-sub" style={{ marginTop: 0 }}>
            The updater removes the connector, its session engines, their networks and itself from the host, and the connector is
            revoked here at once{resources ? <>: the <b>{resources} resource{resources === 1 ? "" : "s"}</b> it serves stop working</> : null}.
            This can&apos;t be undone; to use the host again, add a new connector.
          </p>
          <label className="cn-upd-opt">
            <input type="checkbox" checked={wipe} onChange={(e) => setWipe(e.target.checked)} />
            <span>
              <b>Also delete the recordings on this host and the keys that open them</b>
              <span>{wipe
                ? "Recordings stored on this connector can never be played again, here or anywhere."
                : "Left on the host in the access_connector_data volume, so they can still be backed up or restored (Backup & restore)."}</span>
            </span>
          </label>
          <label className="rs-bulk-to">
            <span>Type <b>{name}</b> to confirm</span>
            <input className="input" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" aria-label="Connector name" />
          </label>
          {error && <p className="notice error" role="alert">{error}</p>}
          <div className="rq-foot">
            <span className="rq-status" />
            <button type="button" className="btn" onClick={close}>Cancel</button>
            <button type="button" className="btn danger" disabled={busy || typed.trim() !== name.trim()} onClick={() => void go()}>
              {busy ? "Removing…" : "Remove from host"}
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="cell-sub" style={{ marginTop: 0 }}>
            {remote && !remote.ok && remote.reason === "offline"
              ? "The connector is offline, so the console can't reach its host."
              : remote && !remote.ok && remote.reason === "no_docker"
                ? "The updater on this host can't reach Docker, so it can't remove anything."
                : "This connector's host has no updater, so the console can't reach into it."}{" "}
            Revoke the connector from its menu instead, then run <b>Clean up the host</b> on the host.
          </p>
          <div className="row-actions">
            <button type="button" className="btn sm" onClick={close}>Close</button>
          </div>
        </>
      )}
    </Modal>
  );
}

export function RemoveFromHostButton({ label = "Remove from host", className = "btn sm danger", ...props }: {
  id: string;
  name: string;
  resources: number;
  remote: RemoteControl | null;
  label?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={className} onClick={() => setOpen(true)}>{label}</button>
      <RemoveFromHostModal open={open} onClose={() => setOpen(false)} {...props} />
    </>
  );
}
