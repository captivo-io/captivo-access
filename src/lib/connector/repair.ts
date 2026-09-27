// Pure, db-free helpers for connector install / re-pair / in-place update. A
// revoked connector can't be re-paired (its token never validates anyway — use
// delete/re-add instead).
import { accessImage, PRUNE_LABEL_FILTER } from "@/lib/images";

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
//   * A TRAILING scoped prune reclaims the disk this upgrade just superseded.
//
// One function serves install (PAIR_CODE set), update (no code, token volume kept),
// and re-pair (clearVolume drops the token volume so the agent re-enrolls). Pure + db-free.
function runCommand(managerUrl: string, tunnelUrl: string, code?: string, clearVolume = false): string {
  const NET = GATEWAY_NETWORK;
  const CONNECTOR = accessImage("connector");
  const KASM = accessImage("kasm-browser");
  const GUACD = "guacamole/guacd:1.6.0";

  const network = `docker network inspect ${NET} >/dev/null 2>&1 || docker network create ${NET} >/dev/null 2>&1; `;
  // Own guacd's volumes as uid 1000 (guacd runs non-root) using the pinned guacd
  // image itself (ships chown) — cached after first install, no Docker Hub busybox.
  // Runs before the connector so the connector mounts already-1000-owned volumes.
  // NOTE on captivo_guacd_recordings: it is EMPTY and always has been. guacd is
  // never given a recording-path, so it writes nothing there -- session recordings
  // are captured by the data plane and stored on the connector under /data/recordings
  // (see connector/recstore.go). The volume is vestigial, kept only because removing
  // it from a live upgrade command buys nothing. Do not read its name as a location.
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
  const kasm = `docker pull ${KASM}; docker rm -f captivo-kasm >/dev/null 2>&1; docker run -d --name captivo-kasm --restart unless-stopped --network ${NET} --shm-size=1g -v captivo_kasm_logs:/kasmlog ${KASM}; `;
  // LAST, and that position is the whole point. Before the pulls the superseded
  // images are still tagged :latest, so nothing is dangling yet and a prune here
  // reclaims NOTHING. It used to run first and therefore always cleaned the
  // PREVIOUS upgrade's leavings -- one release behind, with this upgrade's own
  // garbage left on disk (measured on a real host: 1.5 GB an operator had to
  // reclaim by hand after an update that began with a prune).
  //
  // Scoped to our own images: see PRUNE_LABEL_FILTER. Never touches tagged or
  // in-use images, and never named volumes.
  const prune = `docker image prune -f --filter ${PRUNE_LABEL_FILTER} >/dev/null 2>&1`;

  return network + chown + clear + connector + guacd + kasm + prune;
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
