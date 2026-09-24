// Pure, db-free helpers for connector install / re-pair / in-place update. A
// revoked connector can't be re-paired (its token never validates anyway — use
// delete/re-add instead).
import { accessImage } from "@/lib/images";

export function canRepairConnector(status: string): boolean {
  return status !== "REVOKED";
}

// Shared docker network the connector + guacd join so the connector can reach
// guacd (`captivo-guacd`) by name.
export const GATEWAY_NETWORK = "captivo-gateway";

// The bundle command that brings up a connector host: the connector itself plus
// guacd (the RDP/SSH/VNC engine) and the isolated browser (KasmVNC), all on the
// shared GATEWAY_NETWORK.
//
// Robustness is the whole point of the layout below:
//   * Every service is an INDEPENDENT, idempotent block (`pull; rm -f; run`)
//     separated by `;` — never `&&`. A hiccup in one block (a pull failure, a
//     leftover container name) can no longer cascade into skipping the others.
//   * The connector (the access lifeline) comes up FIRST, right after the network
//     and the volume chown, so it is never gated by the heavier guacd/kasm
//     bundle and its downtime is a single recreate.
//   * No Docker Hub `busybox` dependency: the volume chown reuses the pinned,
//     already-cached guacd image (BusyBox-based) so a host with flaky Docker Hub /
//     IPv6 connectivity can still run it.
//   * A leading dangling-image prune reclaims disk from superseded :latest builds.
//
// One function serves install (PAIR_CODE set), update (no code, token volume kept),
// and re-pair (clearVolume drops the token volume so the agent re-enrolls). Pure + db-free.
function runCommand(managerUrl: string, tunnelUrl: string, code?: string, clearVolume = false): string {
  const NET = GATEWAY_NETWORK;
  const CONNECTOR = accessImage("connector");
  const KASM = accessImage("kasm-browser");
  const GUACD = "guacamole/guacd:1.6.0";

  // Reclaim disk from dangling (untagged) images left by prior :latest pulls; never
  // touches tagged/in-use images or named volumes.
  const prune = `docker image prune -f >/dev/null 2>&1; `;
  const network = `docker network inspect ${NET} >/dev/null 2>&1 || docker network create ${NET} >/dev/null 2>&1; `;
  // Own guacd's volumes as uid 1000 (guacd runs non-root) using the pinned guacd
  // image itself (ships chown) — cached after first install, no Docker Hub busybox.
  // Runs before the connector so the connector mounts already-1000-owned volumes.
  const chown = `docker run --rm --user 0 --entrypoint chown -v captivo_guacd_recordings:/rec -v captivo_guacd_logs:/log -v captivo_guacd_drive:/drive2 ${GUACD} -R 1000:1000 /rec /log /drive2; `;
  // Re-pair only: drop the token volume so the Go agent re-enrolls with the new code.
  const clear = clearVolume
    ? `docker rm -f access-connector >/dev/null 2>&1; docker volume rm access_connector_data >/dev/null 2>&1; `
    : "";
  const connector =
    `docker pull ${CONNECTOR}; docker rm -f access-connector >/dev/null 2>&1; ` +
    `docker run -d --name access-connector --restart unless-stopped --network ${NET} ` +
    `-e MANAGER_URL=${managerUrl} -e DATAPLANE_URL=${tunnelUrl} ` +
    (code ? `-e PAIR_CODE=${code} ` : "") +
    `-v access_connector_data:/data -v captivo_guacd_logs:/guaclog:ro -v captivo_guacd_drive:/drive:rw -v captivo_kasm_logs:/kasmlog:ro ${CONNECTOR}; `;
  // guacd: bypass the entrypoint so our shell wrapper tees guacd's log into the volume.
  const guacd =
    `docker rm -f captivo-guacd >/dev/null 2>&1; ` +
    `docker run -d --name captivo-guacd --restart unless-stopped --network ${NET} ` +
    `-v captivo_guacd_recordings:/recordings -v captivo_guacd_logs:/guaclog -v captivo_guacd_drive:/drive ` +
    `--entrypoint /bin/sh ${GUACD} -c '/opt/guacamole/sbin/guacd -b 0.0.0.0 -L info -f 2>&1 | tee /guaclog/guacd.log'; `;
  // High-fidelity isolated browser (KasmVNC) — the sole isolated-browser transport.
  const kasm = `docker pull ${KASM}; docker rm -f captivo-kasm >/dev/null 2>&1; docker run -d --name captivo-kasm --restart unless-stopped --network ${NET} --shm-size=1g -v captivo_kasm_logs:/kasmlog ${KASM}`;

  return prune + network + chown + clear + connector + guacd + kasm;
}

export function buildConnectorRunCommand(code: string, managerUrl: string, tunnelUrl: string): string {
  return runCommand(managerUrl, tunnelUrl, code);
}

export function buildInstallCommand(code: string, managerUrl: string, tunnelUrl: string): string {
  return buildConnectorRunCommand(code, managerUrl, tunnelUrl);
}

// Re-pair: clear the token volume so the Go agent (which ignores PAIR_CODE when
// /data/token is present) re-enrolls with the new code and rebinds to the SAME
// manager-side connector.
export function buildReconfigureCommand(code: string, managerUrl: string, tunnelUrl: string): string {
  return runCommand(managerUrl, tunnelUrl, code, true);
}

// Update an already-paired connector in place: recreate every container on the
// latest images, KEEPING the token volume (so no re-pairing). No PAIR_CODE — the
// existing /data/token re-authenticates against the same manager-side connector.
export function buildConnectorUpdateCommand(managerUrl: string, tunnelUrl: string): string {
  return runCommand(managerUrl, tunnelUrl);
}
