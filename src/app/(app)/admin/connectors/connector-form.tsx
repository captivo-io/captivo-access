"use client";

import { useState } from "react";
import { CommandBlock } from "@/app/(app)/_shell/command-block";
import { formatShellCommand } from "@/lib/format/docker-command";
import { UpdaterChoice } from "./remote-control";

function errorMessage(code: string | undefined): string {
  switch (code) {
    case "name_required":
      return "A connector name is required.";
    case "forbidden":
      return "Admin privileges are required for this action.";
    case "limit_reached":
      return "Your plan's connector limit is reached — contact your platform operator to raise it.";
    default:
      return "Couldn't create the connector, please try again.";
  }
}

export function ConnectorForm({ onDone }: { onDone?: () => void }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pairing, setPairing] = useState<{ code: string; installCommand: string; installCommandManual: string; installCommandWindows?: string; installCommandLinux?: string; managerUrlIsLocal: boolean } | null>(null);
  const [host, setHost] = useState<"docker" | "linux" | "windows">("docker");
  const [withUpdater, setWithUpdater] = useState(true);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setPairing(null);
    setBusy(true);
    try {
      const res = await fetch("/api/admin/connectors", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const result = await res.json().catch(() => ({}));
      if (!res.ok || !result?.code) {
        setError(errorMessage(result?.error));
        return;
      }
      setPairing({
        code: result.code,
        installCommand: result.installCommand,
        installCommandManual: result.installCommandManual ?? result.installCommand,
        installCommandWindows: result.installCommandWindows,
        installCommandLinux: result.installCommandLinux,
        managerUrlIsLocal: Boolean(result.managerUrlIsLocal),
      });
      setName("");
      setHost("docker");
    } catch {
      setError("Couldn't create the connector, please try again.");
    } finally {
      setBusy(false);
    }
  }


  return (
    <div>
      {!pairing ? (
        <form onSubmit={handleSubmit}>
          <div className="field">
            <label className="field-label" htmlFor="connector-name">
              Connector name
            </label>
            <input
              id="connector-name"
              type="text"
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              placeholder="e.g. Customer HQ"
            />
          </div>
          <p className="cell-sub">
            The install command deploys the connector together with both session engines — guacd (for
            remote-desktop resources: RDP/SSH/VNC) and KasmVNC (for isolated-browser resources) — so this host
            can serve web apps, remote desktops, and isolated browsers alike. One command, nothing else to install.
          </p>
          {error && (
            <p className="notice error" role="alert">
              {error}
            </p>
          )}
          <button type="submit" className="btn primary" disabled={busy}>
            {busy ? "Creating…" : "Add connector"}
          </button>
        </form>
      ) : (
        <div role="status" className="notice">
          <p>
            <span className="pill ok">Pairing created</span>
          </p>
          <p>
            Run the command below on a host inside the customer&apos;s network. The connector then shows up
            in the list (as <b>Pending</b>, then <b>Online</b>) once it connects — creating it here doesn&apos;t
            add a row until then. This pairing code is shown only once.
          </p>
          {(pairing.installCommandWindows || pairing.installCommandLinux) && (
            <div className="seg" role="tablist" aria-label="Where it runs">
              {([["docker", "Docker"], ["linux", "Linux service"], ["windows", "Windows service"]] as const)
                .filter(([k]) => k === "docker" || (k === "linux" ? pairing.installCommandLinux : pairing.installCommandWindows))
                .map(([k, l]) => (
                  <button key={k} type="button" role="tab" aria-selected={host === k} className={host === k ? "seg-opt on" : "seg-opt"} onClick={() => setHost(k)}>{l}</button>
                ))}
            </div>
          )}
          {host === "docker" ? (
            <>
              <UpdaterChoice on={withUpdater} onChange={setWithUpdater} />
              <CommandBlock
                command={withUpdater ? pairing.installCommand : pairing.installCommandManual}
                display={formatShellCommand(withUpdater ? pairing.installCommand : pairing.installCommandManual)}
                title="connector-install"
              />
            </>
          ) : (
            <>
              <p className="cell-sub">
                Installs the connector as {host === "windows" ? "a Windows service (run it from an elevated PowerShell)" : "a systemd service (it asks for sudo)"}, with no Docker. It serves web apps,
                databases, Kubernetes clusters and TCP tunnels. Remote desktops, SSH in the browser and isolated browsers
                need the Docker install, which brings the engines for them. Update it later with{" "}
                <code>{host === "windows" ? "connector.exe update" : "captivo-connector update"}</code> on the host.
              </p>
              {(() => {
                const cmd = host === "windows" ? pairing.installCommandWindows! : pairing.installCommandLinux!;
                return <CommandBlock command={cmd} display={cmd.replace(/; /g, ";\n")} title={host === "windows" ? "connector-install-windows" : "connector-install-linux"} />;
              })()}
            </>
          )}
          {pairing.managerUrlIsLocal && (
            <p className="notice error">
              <code>MANAGER_URL</code> points at <code>localhost</code> (you&apos;re viewing this over
              a tunnel). The connector runs on another machine and can&apos;t reach it there — replace
              it with the manager&apos;s real address (set <code>MANAGER_PUBLIC_URL</code> in the
              server&apos;s <code>.env</code>).
            </p>
          )}
          <p>
            This connector needs no per-app configuration. Define each internal app as a{" "}
            <b>Resource</b> (with its internal address) in the console — the connector reads that address
            from the Manager and dials it directly.
          </p>
          <p>
            To cap what this connector may reach, optionally set <code>ALLOWED_TARGETS</code> (e.g.{" "}
            <code>10.0.5.0/24</code>) on the container. Unset means it dials whatever the Manager
            routes to it.
          </p>
          <p>
            <code>MANAGER_URL</code> and <code>DATAPLANE_URL</code> are filled from your server config
            (<code>MANAGER_PUBLIC_URL</code> / <code>CONNECTOR_TUNNEL_URL</code>). If{" "}
            <code>DATAPLANE_URL</code> still shows a <code>&lt;your-access-domain&gt;</code>{" "}
            placeholder, set <code>CONNECTOR_TUNNEL_URL</code> (e.g.{" "}
            <code>wss://connect.your-domain</code>) in the server&apos;s <code>.env</code>. Always use{" "}
            <code>wss://</code> — a plain <code>ws://</code> tunnel is unencrypted.
          </p>
          <div className="row-actions">
            <button type="button" className="btn primary" onClick={() => (onDone ? onDone() : setPairing(null))}>Done</button>
          </div>
        </div>
      )}
    </div>
  );
}
