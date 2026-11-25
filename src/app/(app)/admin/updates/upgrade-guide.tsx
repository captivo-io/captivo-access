import { CommandBlock } from "@/app/(app)/_shell/command-block";
import { formatShellCommand } from "@/lib/format/docker-command";
import { serverUpgradeCommand } from "@/lib/updates/server-upgrade";

// Renders the "How to upgrade" card. Displays commands only — the app never runs
// them. `connectorCommand` is null when no connector is outdated (lib/updates/semver.ts).
export function UpgradeGuide({
  currentVersion,
  latestVersion,
  latestUrl,
  connectorCommand,
  outdatedConnectors,
}: {
  currentVersion: string;
  latestVersion: string;
  latestUrl: string | null;
  connectorCommand: string | null;
  outdatedConnectors: number;
}) {
  const serverCommand = serverUpgradeCommand(latestVersion);
  return (
    <div className="card">
      <div className="card-head">
        <h2>How to upgrade</h2>
      </div>
      <p className="cell-sub">
        Captivo Access <strong>v{latestVersion}</strong> is available — you&apos;re on{" "}
        <strong>v{currentVersion}</strong>.
        {latestUrl && (
          <>
            {" "}
            <a href={latestUrl} target="_blank" rel="noreferrer">
              Release notes
            </a>
            .
          </>
        )}
      </p>

      <div className="field">
        <label className="field-label">On your server</label>
        <p className="cell-sub">
          Moves <code>CAPTIVO_VERSION</code> in <code>.env</code> to v{latestVersion}, then upgrades the manager and
          data-plane and applies any schema change automatically.
        </p>
        <CommandBlock
          command={serverCommand}
          display={serverCommand.replace(/ && /g, " && \\\n  ")}
          title="server-upgrade"
        />
      </div>

      {connectorCommand && (
        <div className="field">
          <label className="field-label">On each connector host</label>
          <p className="cell-sub">
            {outdatedConnectors} connector{outdatedConnectors === 1 ? "" : "s"} need{outdatedConnectors === 1 ? "s" : ""} an update.
            A connector with the updater beside it updates from the Connectors page in one click, once the
            manager is upgraded. For the others, run this once on each connector&apos;s host — the token
            volume is kept, so no re-pairing, and it installs the updater for next time.
          </p>
          <CommandBlock
            command={connectorCommand}
            display={formatShellCommand(connectorCommand)}
            title="connector-update"
          />
        </div>
      )}
    </div>
  );
}
