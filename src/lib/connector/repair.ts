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
// The connector's /data: its token, its recordings, its recording key and its
// vault key. Nothing else holds the last three (see backup.ts).
export const CONNECTOR_DATA_VOLUME = "access_connector_data";
// The isolated browser alone, with no route out (see runCommand).
export const ISOLATED_NETWORK = "captivo-isolated";

// The updater beside the connector (updater/): the one container on a connector
// host with Docker access, so the console can update or remove the connector.
// It takes no input from the network; the connector hands it requests through
// the hostctl volume. See docs/how-it-works.md, "Updates from the console".
export const UPDATER_CONTAINER = "captivo-updater";
export const HOSTCTL_VOLUME = "captivo_hostctl";

/**
 * What a command needs from the place it runs. A command an admin pastes on the
 * host carries literal values and lets the host's shell fill in its own facts;
 * the updater's recipe (buildUpdaterRecipe) carries shell variables the updater
 * sets from the running connector instead.
 */
interface RunVars {
  managerUrl: string;
  tunnelUrl: string;
  hostname: string;
  hostIp: string;
  hostOs: string;
  connector: string;
  guacd: string;
  kasm: string;
  updater: string;
}

function pasteVars(managerUrl: string, tunnelUrl: string): RunVars {
  return {
    managerUrl,
    tunnelUrl,
    // The host's name, address and OS for the Connectors card: a container sees only itself.
    hostname: `"$(hostname)"`,
    hostIp: `"$(hostname -I 2>/dev/null)"`,
    hostOs: `"$(sed -n s/^PRETTY_NAME=//p /etc/os-release 2>/dev/null)"`,
    connector: accessImage("connector"),
    // Apache's guacd 1.6.0 with libguac-terminal patched (guacd/Dockerfile): the
    // stock one printed every OSC sequence it does not implement, so SSH to a
    // systemd 257+ host showed "tart=...;user=root;..." before each prompt.
    guacd: accessImage("guacd"),
    kasm: accessImage("kasm-browser"),
    updater: accessImage("updater"),
  };
}

const RECIPE_VARS: RunVars = {
  managerUrl: `"$MANAGER_URL"`,
  tunnelUrl: `"$DATAPLANE_URL"`,
  hostname: `"$HOST_NAME"`,
  hostIp: `"$HOST_IP"`,
  hostOs: `"$HOST_OS"`,
  connector: `"$CONNECTOR_IMAGE"`,
  guacd: `"$GUACD_IMAGE"`,
  kasm: `"$KASM_IMAGE"`,
  updater: `"$UPDATER_IMAGE"`,
};

// The bundle command that brings up a connector host: the connector itself plus
// guacd (the RDP/SSH/VNC engine), the isolated browser (KasmVNC) and, unless the
// admin turned it off, the updater, all on the shared GATEWAY_NETWORK.
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
// re-pair (clearVolume drops the token so the agent re-enrolls) and the updater's
// own recipe. Pure + db-free.
function runCommand(v: RunVars, opts: { code?: string; clearVolume?: boolean; remote: boolean }): string {
  const NET = GATEWAY_NETWORK;
  const { connector: CONNECTOR, guacd: GUACD, kasm: KASM, updater: UPDATER } = v;

  const network =
    `docker network inspect ${NET} >/dev/null 2>&1 || docker network create ${NET} >/dev/null 2>&1; ` +
    // The isolated browser's network: --internal, so it has no way out but the
    // connector's egress proxy (connector/egress.go), which applies each
    // session's rule. The connector joins it to serve the proxy and reach the
    // browser; nothing else is on it.
    `docker network inspect ${ISOLATED_NETWORK} >/dev/null 2>&1 || docker network create --internal ${ISOLATED_NETWORK} >/dev/null 2>&1; `;
  // Own guacd's volumes as uid 1000 (guacd runs non-root) using the pinned guacd
  // image itself (ships chown) — cached after first install, no Docker Hub busybox.
  // Runs before the connector so the connector mounts already-1000-owned volumes.
  // NOTE on captivo_guacd_recordings: it is EMPTY and always has been. guacd is
  // never given a recording-path, so it writes nothing there -- session recordings
  // are captured by the data plane and stored on the connector under /data/recordings
  // (see connector/recstore.go). The volume is vestigial, kept only because removing
  // it from a live upgrade command buys nothing. Do not read its name as a location.
  // Pulled every time: guacd now tracks our :latest (with the OSC fix), and a
  // tag already on the host is otherwise reused as is, so an update would never
  // bring a fixed guacd.
  // The hostctl volume is the connector's (uid 10001) to write requests into.
  const chown =
    `docker pull ${GUACD}; docker run --rm --user 0 --entrypoint chown -v captivo_guacd_recordings:/rec -v captivo_guacd_logs:/log -v captivo_guacd_drive:/drive2 ${GUACD} -R 1000:1000 /rec /log /drive2; ` +
    `docker run --rm --user 0 --entrypoint chown -v ${HOSTCTL_VOLUME}:/hostctl ${GUACD} 10001:10001 /hostctl; `;
  // The isolated browser's control-service secret: generated once on this host,
  // kept across updates, never sent anywhere but the data-plane connection. It
  // must exist BEFORE the connector starts, which reads it for its handshake
  // (connector/kasmtoken.go); the broker reads it from the same volume
  // (kasm-browser/control.py). Made with the guacd image just pulled above.
  const kasmSecret = `docker run --rm --user 0 --entrypoint sh -v captivo_kasm_secret:/secret ${GUACD} -c '[ -s /secret/token ] || head -c 32 /dev/urandom | od -An -tx1 | tr -d " \\n" > /secret/token; chown 10001:10001 /secret/token; chmod 400 /secret/token; chmod 711 /secret'; `;
  // Re-pair only: delete the stored token so the Go agent re-enrolls with the new
  // code. ONLY the token: the same volume holds the connector's recordings, its
  // recording key and its vault key, none of which exist anywhere else. (This
  // used to remove the whole volume, silently destroying all three.)
  const clear = opts.clearVolume
    ? `docker rm -f access-connector >/dev/null 2>&1; docker run --rm --user 0 --entrypoint rm -v ${CONNECTOR_DATA_VOLUME}:/data ${GUACD} -f /data/token; `
    : "";
  const connector =
    `docker pull ${CONNECTOR}; docker rm -f access-connector >/dev/null 2>&1; ` +
    `docker run -d --name access-connector --restart unless-stopped --network ${NET} ` +
    `--hostname ${v.hostname} -e HOST_IP=${v.hostIp} -e HOST_OS=${v.hostOs} ` +
    `-e MANAGER_URL=${v.managerUrl} -e DATAPLANE_URL=${v.tunnelUrl} ` +
    (opts.code ? `-e PAIR_CODE=${opts.code} ` : "") +
    `-v ${CONNECTOR_DATA_VOLUME}:/data -v captivo_guacd_logs:/guaclog:ro -v captivo_guacd_drive:/drive:rw -v captivo_kasm_logs:/kasmlog:ro -v captivo_kasm_secret:/kasmsecret:ro -v ${HOSTCTL_VOLUME}:/hostctl ${CONNECTOR}; ` +
    `docker network connect ${ISOLATED_NETWORK} access-connector >/dev/null 2>&1; `;
  // guacd: bypass the entrypoint so our shell wrapper tees guacd's log into the volume.
  const guacd =
    `docker rm -f captivo-guacd >/dev/null 2>&1; ` +
    `docker run -d --name captivo-guacd --restart unless-stopped --network ${NET} ` +
    `-v captivo_guacd_recordings:/recordings -v captivo_guacd_logs:/guaclog -v captivo_guacd_drive:/drive ` +
    `--entrypoint /bin/sh ${GUACD} -c '/opt/guacamole/sbin/guacd -b 0.0.0.0 -L info -f 2>&1 | tee /guaclog/guacd.log'; `;
  // High-fidelity isolated browser (KasmVNC) — the sole isolated-browser transport.
  const kasm = `docker pull ${KASM}; docker rm -f captivo-kasm >/dev/null 2>&1; docker run -d --name captivo-kasm --restart unless-stopped --network ${ISOLATED_NETWORK} --shm-size=1g -v captivo_kasm_logs:/kasmlog -v captivo_kasm_secret:/secret ${KASM}; `;
  // The updater has the host's Docker socket and no network at all (pulls are
  // the Docker daemon's, not the container's). Turned off, the command removes
  // one a previous command installed: the command states what the host runs.
  // Last of the containers: when the updater itself runs this as its recipe,
  // replacing it is the final step, after everything else is up.
  const updater = opts.remote
    ? `docker pull ${UPDATER}; docker rm -f ${UPDATER_CONTAINER} >/dev/null 2>&1; docker run -d --name ${UPDATER_CONTAINER} --restart unless-stopped --network none -v /var/run/docker.sock:/var/run/docker.sock -v ${HOSTCTL_VOLUME}:/hostctl ${UPDATER}; `
    : `docker rm -f ${UPDATER_CONTAINER} >/dev/null 2>&1; `;
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

  return network + chown + kasmSecret + clear + connector + guacd + kasm + updater + prune;
}

// `remote` (default on): install the updater, so this console can update and
// remove the connector. Off, the host has no container with Docker access and
// every update is this command, run by hand.
export function buildConnectorRunCommand(code: string, managerUrl: string, tunnelUrl: string, remote = true): string {
  return runCommand(pasteVars(managerUrl, tunnelUrl), { code, remote });
}

export function buildInstallCommand(code: string, managerUrl: string, tunnelUrl: string, remote = true): string {
  return buildConnectorRunCommand(code, managerUrl, tunnelUrl, remote);
}

// Re-pair: delete /data/token so the Go agent (which ignores PAIR_CODE when
// /data/token is present) re-enrolls with the new code and rebinds to the SAME
// manager-side connector.
export function buildReconfigureCommand(code: string, managerUrl: string, tunnelUrl: string, remote = true): string {
  return runCommand(pasteVars(managerUrl, tunnelUrl), { code, clearVolume: true, remote });
}

// Update an already-paired connector in place: recreate every container on the
// latest images, KEEPING the token volume (so no re-pairing). No PAIR_CODE — the
// existing /data/token re-authenticates against the same manager-side connector.
export function buildConnectorUpdateCommand(managerUrl: string, tunnelUrl: string, remote = true): string {
  return runCommand(pasteVars(managerUrl, tunnelUrl), { remote });
}

// Everything runCommand leaves on a host, for taking a connector off it for
// good. Keep in step with runCommand when a container, volume or network is added.
const HOST_CONTAINERS = ["access-connector", "captivo-guacd", "captivo-kasm", UPDATER_CONTAINER];
const HOST_VOLUMES = [CONNECTOR_DATA_VOLUME, "captivo_guacd_recordings", "captivo_guacd_logs", "captivo_guacd_drive", "captivo_kasm_logs", "captivo_kasm_secret", HOSTCTL_VOLUME];
const HOST_NETWORKS = [GATEWAY_NETWORK, ISOLATED_NETWORK];

/**
 * Removes a connector from its host: containers, volumes (token, recordings,
 * recording and vault keys), networks and images. One command per line, so a
 * name the host lacks (an older install) fails on its own and the rest still run.
 */
export function buildConnectorCleanupCommand(): string {
  const images = (["connector", "guacd", "kasm-browser", "updater"] as const).map((n) => accessImage(n));
  return [
    `docker rm -f ${HOST_CONTAINERS.join(" ")}`,
    `docker volume rm ${HOST_VOLUMES.join(" ")}`,
    `docker network rm ${HOST_NETWORKS.join(" ")}`,
    `docker image rm ${images.join(" ")}`,
    `docker image prune -f --filter ${PRUNE_LABEL_FILTER}`,
  ].join("\n");
}

// The same removal as the updater runs it ("Remove from host" in the console).
// KEEP_DATA=1 leaves the data volume (recordings and the keys that open them)
// and deletes only the token in it, which is useless once the connector is
// revoked. Every tag of our images goes, whatever version the host ran, except
// the updater image this runs from (one image, about 50 MB).
function uninstallRecipe(): string {
  const v = RECIPE_VARS;
  const others = HOST_VOLUMES.filter((n) => n !== CONNECTOR_DATA_VOLUME);
  return [
    `docker rm -f ${HOST_CONTAINERS.join(" ")}`,
    `if [ "\${KEEP_DATA:-0}" = 1 ]; then`,
    `  docker run --rm --user 0 --entrypoint rm -v ${CONNECTOR_DATA_VOLUME}:/data ${v.updater} -f /data/token`,
    `  docker volume rm ${others.join(" ")}`,
    `else`,
    `  docker volume rm ${HOST_VOLUMES.join(" ")}`,
    `fi`,
    `docker network rm ${HOST_NETWORKS.join(" ")}`,
    `for repo in "\${CONNECTOR_IMAGE%:*}" "\${GUACD_IMAGE%:*}" "\${KASM_IMAGE%:*}"; do docker image ls -q "$repo" | sort -u | xargs -r docker image rm -f; done`,
    `docker image ls --format '{{.Repository}}:{{.Tag}}' "\${UPDATER_IMAGE%:*}" | grep -vxF "$UPDATER_IMAGE" | xargs -r docker image rm`,
    `docker image prune -f --filter ${PRUNE_LABEL_FILTER}`,
  ].join("\n");
}

/**
 * The script the updater image carries (updater/recipe.sh), generated from the
 * same runCommand an admin pastes so the two cannot drift: recipe.test.ts fails
 * when the committed file differs. The updater runs it in a one-shot container
 * with the host's Docker socket, setting every variable from the connector
 * already on the host and from the version the console asked for.
 */
export function buildUpdaterRecipe(): string {
  return [
    "#!/bin/sh",
    "# GENERATED by buildUpdaterRecipe() in src/lib/connector/repair.ts. Do not edit:",
    "# regenerate with UPDATE_RECIPE=1 npx vitest run src/lib/connector/recipe.test.ts",
    "#",
    "# Run by the updater (updater/main.go) in a one-shot container with the host's",
    "# Docker socket. Inputs, all set by the updater:",
    "#   MANAGER_URL DATAPLANE_URL HOST_NAME HOST_IP HOST_OS  (from the running connector)",
    "#   CONNECTOR_IMAGE GUACD_IMAGE KASM_IMAGE UPDATER_IMAGE (the version to run)",
    "#   KEEP_DATA                                            (uninstall: 1 keeps the data volume)",
    "set -u",
    'case "${1:-}" in',
    "update)",
    runCommand(RECIPE_VARS, { remote: true }),
    ";;",
    "uninstall)",
    uninstallRecipe(),
    ";;",
    "*)",
    'echo "usage: recipe.sh update|uninstall" >&2',
    "exit 2",
    ";;",
    "esac",
    "",
  ].join("\n");
}
