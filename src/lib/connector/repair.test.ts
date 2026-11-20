import { describe, it, expect } from "vitest";
import { PRUNE_LABEL_FILTER, accessImage } from "@/lib/images";
import {
  canRepairConnector,
  buildReconfigureCommand,
  buildConnectorRunCommand,
  buildConnectorUpdateCommand,
  GATEWAY_NETWORK,
  buildInstallCommand,
  buildConnectorCleanupCommand,
} from "./repair";

describe("canRepairConnector", () => {
  it("allows re-pair for non-revoked connectors", () => {
    expect(canRepairConnector("PENDING")).toBe(true);
    expect(canRepairConnector("ONLINE")).toBe(true);
    expect(canRepairConnector("OFFLINE")).toBe(true);
  });
  it("blocks re-pair for a revoked connector", () => {
    expect(canRepairConnector("REVOKED")).toBe(false);
  });
});

describe("buildReconfigureCommand", () => {
  it("deletes only the old token and re-runs with the new pair code", () => {
    const cmd = buildReconfigureCommand("CODE123", "https://mgr.example.com", "wss://connect.example.com");
    expect(cmd).toContain("docker rm -f access-connector");
    expect(cmd).toMatch(/-v access_connector_data:\/data \S+ -f \/data\/token;/);
    // The volume also holds the recordings and their key and the vault key.
    expect(cmd).not.toContain("docker volume rm");
    expect(cmd).toContain("PAIR_CODE=CODE123");
    expect(cmd).toContain("MANAGER_URL=https://mgr.example.com");
    expect(cmd).toContain("DATAPLANE_URL=wss://connect.example.com");
    expect(cmd).toContain("ghcr.io/captivo-io/captivo-access-connector:latest");
  });
});

describe("buildConnectorRunCommand", () => {
  it("has the run flags and never wipes the token volume", () => {
    const cmd = buildConnectorRunCommand("CODE123", "https://mgr.example.com", "wss://connect.example.com");
    expect(cmd).toContain("docker run -d --name access-connector");
    expect(cmd).toContain("PAIR_CODE=CODE123");
    // Recreating the container idempotently (rm -f before run) is expected; only
    // re-pair wipes the token volume that holds the connector's identity.
    expect(cmd).not.toContain("docker volume rm");
  });
  it("no command removes the connector's data volume", () => {
    expect(buildReconfigureCommand("C", "M", "T")).not.toContain("docker volume rm");
    expect(buildConnectorRunCommand("C", "M", "T")).not.toContain("docker volume rm");
    expect(buildConnectorUpdateCommand("M", "T")).not.toContain("docker volume rm");
  });
  it("is resilient: connector comes up before the guacd/kasm bundle, no busybox", () => {
    const cmd = buildConnectorUpdateCommand("M", "T");
    expect(cmd).not.toContain("busybox");
    // The connector (access lifeline) is recreated before the heavier bundle so a
    // bundle failure can't leave it down.
    expect(cmd.indexOf("--name access-connector")).toBeLessThan(cmd.indexOf("--name captivo-guacd"));
  });

  // The prune used to run FIRST, and a test that only asserted it was present
  // could not see the bug: before the pulls the superseded images are still tagged
  // :latest, nothing is dangling, and the prune reclaims nothing. It cleaned the
  // previous upgrade's leavings instead -- one release behind, 1.5 GB left on a
  // real host until an operator pruned by hand.
  it("prunes AFTER every pull, so it reclaims what this upgrade superseded", () => {
    for (const cmd of [
      buildConnectorRunCommand("C", "M", "T"),
      buildConnectorUpdateCommand("M", "T"),
      buildReconfigureCommand("C", "M", "T"),
    ]) {
      const prune = cmd.indexOf("docker image prune");
      expect(prune, "no prune at all").toBeGreaterThan(-1);
      expect(cmd.lastIndexOf("docker pull"), "prune runs before a pull that orphans an image")
        .toBeLessThan(prune);
    }
  });

  // An unscoped prune runs as root on a CUSTOMER's host and would delete every
  // dangling image there, including from software we do not ship.
  it("scopes the prune to images this product published", () => {
    const cmd = buildConnectorUpdateCommand("M", "T");
    expect(cmd).toContain(`docker image prune -f --filter ${PRUNE_LABEL_FILTER}`);
    expect(PRUNE_LABEL_FILTER).toContain("org.opencontainers.image.title");
  });
});

describe("buildConnectorUpdateCommand", () => {
  it("pulls the new image and recreates the container without re-pairing", () => {
    const cmd = buildConnectorUpdateCommand("https://mgr.example.com", "wss://connect.example.com");
    expect(cmd).toContain("docker pull ghcr.io/captivo-io/captivo-access-connector:latest");
    expect(cmd).toContain("docker rm -f access-connector");
    expect(cmd).toContain("MANAGER_URL=https://mgr.example.com");
    expect(cmd).toContain("DATAPLANE_URL=wss://connect.example.com");
    expect(cmd).toContain("-v access_connector_data:/data");
    expect(cmd).toContain("ghcr.io/captivo-io/captivo-access-connector:latest");
  });
  it("does NOT include a pair code or wipe the token volume", () => {
    const cmd = buildConnectorUpdateCommand("https://mgr.example.com", "wss://connect.example.com");
    expect(cmd).not.toContain("PAIR_CODE");
    expect(cmd).not.toContain("docker volume rm");
  });
});

describe("every connector bundles guacd on the shared network", () => {
  const m = "https://manager.access.example.com";
  const t = "wss://connect.access.example.com";

  it("install always joins the network + ensure-prefix", () => {
    const cmd = buildInstallCommand("CODE123", m, t);
    expect(cmd).toContain(`--network ${GATEWAY_NETWORK}`);
    expect(cmd).toContain(`docker network inspect ${GATEWAY_NETWORK}`);
    expect(cmd).toContain(`docker network create ${GATEWAY_NETWORK}`);
  });

  it("update always joins the network", () => {
    const cmd = buildConnectorUpdateCommand(m, t);
    expect(cmd).toContain(`--network ${GATEWAY_NETWORK}`);
    expect(cmd).toContain("docker pull");
  });

  it("re-pair always joins the network", () => {
    expect(buildReconfigureCommand("CODE123", m, t)).toContain(`--network ${GATEWAY_NETWORK}`);
  });

  it("install includes guacd + recordings volume", () => {
    const cmd = buildInstallCommand("CODE123", m, t);
    expect(cmd).toContain("--name captivo-guacd");
    expect(cmd).toContain("captivo_guacd_recordings");
    // Our patched guacd (guacd/Dockerfile), not Apache's stock image.
    expect(cmd).toContain(accessImage("guacd"));
    expect(cmd).not.toContain("guacamole/guacd");
    expect(cmd).toContain("docker run -d --name access-connector");
  });
  it("the isolated browser's control secret exists before the connector starts, and both mount it", () => {
    for (const cmd of [buildInstallCommand("CODE123", m, t), buildConnectorUpdateCommand(m, t)]) {
      const gen = cmd.indexOf("-v captivo_kasm_secret:/secret " + accessImage("guacd"));
      expect(gen).toBeGreaterThan(-1);
      // Generated once, kept across updates.
      expect(cmd).toContain("[ -s /secret/token ] ||");
      expect(gen).toBeLessThan(cmd.indexOf("--name access-connector"));
      expect(cmd).toContain("-v captivo_kasm_secret:/kasmsecret:ro -v captivo_hostctl:/hostctl " + accessImage("connector"));
      expect(cmd).toContain("-v captivo_kasm_secret:/secret " + accessImage("kasm-browser"));
    }
  });
  it("update re-provisions guacd", () => {
    const cmd = buildConnectorUpdateCommand(m, t);
    expect(cmd).toContain("--name captivo-guacd");
    // :latest is only refreshed by a pull, and it must come before the chown
    // that already runs the image.
    expect(cmd).toContain(`docker pull ${accessImage("guacd")}`);
    expect(cmd.indexOf(`docker pull ${accessImage("guacd")}`)).toBeLessThan(cmd.indexOf("--entrypoint chown"));
    expect(cmd).toContain("docker pull ghcr.io/captivo-io/captivo-access-connector:latest");
  });
  it("install/update bundle the KasmVNC (hi-fi) browser, pulled fresh", () => {
    expect(buildInstallCommand("CODE123", m, t)).toContain("--name captivo-kasm");
    expect(buildInstallCommand("CODE123", m, t)).toContain("docker pull ghcr.io/captivo-io/captivo-access-kasm-browser:latest");
    expect(buildConnectorUpdateCommand(m, t)).toContain("--name captivo-kasm");
  });
  it("captures guacd logs to a shared volume", () => {
    const cmd = buildInstallCommand("CODE123", m, t);
    expect(cmd).toContain("-v captivo_guacd_logs:/guaclog ");
    // guacd 1.6.0's entrypoint swallows a CMD; bypass it so our tee wrapper runs.
    expect(cmd).toContain(`--entrypoint /bin/sh ${accessImage("guacd")}`);
    expect(cmd).toContain("tee /guaclog/guacd.log");
    // File-transfer drive volume: mounted on guacd + chowned + mounted on the connector for pruning.
    expect(cmd).toContain("captivo_guacd_drive");
    // chown runs via the pinned guacd image (--entrypoint chown), not busybox.
    expect(cmd).toContain("-R 1000:1000 /rec /log /drive2");
    expect(cmd).toContain("--entrypoint chown");
    expect(cmd).toContain("-v captivo_guacd_logs:/guaclog:ro");
  });
  it("captures isolated-browser (kasm) logs to a shared volume (install + update)", () => {
    for (const cmd of [buildInstallCommand("CODE123", m, t), buildConnectorUpdateCommand(m, t)]) {
      expect(cmd).toContain("-v captivo_kasm_logs:/kasmlog "); // kasm writes
      expect(cmd).toContain("-v captivo_kasm_logs:/kasmlog:ro"); // connector reads
    }
  });
});

describe("install/re-pair pull the newest connector image", () => {
  const m = "https://mgr.example.com";
  const t = "wss://connect.example.com";
  const PULL = "docker pull ghcr.io/captivo-io/captivo-access-connector:latest";

  it("install pulls latest before running (avoids a stale cached :latest)", () => {
    expect(buildInstallCommand("CODE123", m, t)).toContain(PULL);
  });
  it("re-pair pulls latest before running", () => {
    expect(buildReconfigureCommand("CODE123", m, t)).toContain(PULL);
  });
  it("update pulls exactly once (no double pull)", () => {
    const cmd = buildConnectorUpdateCommand(m, t);
    expect(cmd.split(PULL).length - 1).toBe(1);
  });
});

describe("the isolated browser has no network but the connector", () => {
  const cmd = buildConnectorUpdateCommand("https://m.test", "wss://t.test");
  it("creates an internal network, runs the isolated browser only on it, and joins the connector to it", () => {
    expect(cmd).toContain("docker network create --internal captivo-isolated");
    expect(cmd).toMatch(/docker run -d --name captivo-kasm [^;]*--network captivo-isolated /);
    expect(cmd).not.toMatch(/docker run -d --name captivo-kasm [^;]*--network captivo-gateway/);
    const join = cmd.indexOf("docker network connect captivo-isolated access-connector");
    expect(join).toBeGreaterThan(cmd.indexOf("docker run -d --name access-connector"));
    expect(join).toBeLessThan(cmd.indexOf("docker run -d --name captivo-kasm"));
  });
});

describe("buildConnectorCleanupCommand", () => {
  const install = buildConnectorRunCommand("CODE", "https://m.example", "wss://d.example");
  const cleanup = buildConnectorCleanupCommand();

  it("removes every container, volume and network the install command creates", () => {
    const named = (re: RegExp) => [...new Set([...install.matchAll(re)].map((m) => m[1]))];
    for (const c of named(/--name (\S+)/g)) expect(cleanup).toMatch(new RegExp(`docker rm -f .*\\b${c}\\b`));
    for (const v of named(/-v ([a-z_]+):\//g)) expect(cleanup).toMatch(new RegExp(`docker volume rm .*\\b${v}\\b`));
    for (const n of named(/docker network create (?:--internal )?(\S+)/g)) expect(cleanup).toMatch(new RegExp(`docker network rm .*\\b${n}\\b`));
  });

  it("is one command per line so a missing name does not stop the rest", () => {
    expect(cleanup.split("\n")).toHaveLength(5);
    expect(cleanup).not.toMatch(/&&|;/);
  });
});

describe("the updater (updates and removal from the console)", () => {
  const m = "https://mgr.example.com";
  const t = "wss://connect.example.com";

  it("is installed by default, with the Docker socket and no network, after the other containers", () => {
    for (const cmd of [buildInstallCommand("C", m, t), buildConnectorUpdateCommand(m, t), buildReconfigureCommand("C", m, t)]) {
      expect(cmd).toMatch(/docker run -d --name captivo-updater --restart unless-stopped --network none -v \/var\/run\/docker\.sock:\/var\/run\/docker\.sock -v captivo_hostctl:\/hostctl \S+captivo-access-updater:latest;/);
      expect(cmd.indexOf("--name captivo-updater")).toBeGreaterThan(cmd.indexOf("--name captivo-kasm"));
      expect(cmd.indexOf("--name captivo-updater")).toBeLessThan(cmd.indexOf("docker image prune"));
    }
  });

  it("only the updater gets the Docker socket", () => {
    const cmd = buildConnectorUpdateCommand(m, t);
    expect(cmd.split("docker.sock:/var/run/docker.sock").length - 1).toBe(1);
    expect(cmd).not.toMatch(/--name access-connector [^;]*docker\.sock/);
  });

  it("turned off, the command removes an updater a previous command installed", () => {
    for (const cmd of [buildInstallCommand("C", m, t, false), buildConnectorUpdateCommand(m, t, false), buildReconfigureCommand("C", m, t, false)]) {
      expect(cmd).not.toContain("docker.sock");
      expect(cmd).not.toContain("captivo-access-updater");
      expect(cmd).toContain("docker rm -f captivo-updater >/dev/null 2>&1;");
    }
  });

  it("the connector can write into the hostctl volume", () => {
    const cmd = buildConnectorUpdateCommand(m, t);
    const chown = cmd.indexOf("-v captivo_hostctl:/hostctl " + accessImage("guacd") + " 10001:10001 /hostctl");
    expect(chown).toBeGreaterThan(-1);
    expect(chown).toBeLessThan(cmd.indexOf("--name access-connector"));
  });
});
