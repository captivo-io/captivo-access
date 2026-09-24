import { describe, it, expect } from "vitest";
import {
  canRepairConnector,
  buildReconfigureCommand,
  buildConnectorRunCommand,
  buildConnectorUpdateCommand,
  GATEWAY_NETWORK,
  buildInstallCommand,
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
  it("clears the old token volume and re-runs with the new pair code", () => {
    const cmd = buildReconfigureCommand("CODE123", "https://mgr.example.com", "wss://connect.example.com");
    expect(cmd).toContain("docker rm -f access-connector");
    expect(cmd).toContain("docker volume rm access_connector_data");
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
  it("only re-pair wipes the token volume", () => {
    expect(buildReconfigureCommand("C", "M", "T")).toContain("docker volume rm access_connector_data");
    expect(buildConnectorRunCommand("C", "M", "T")).not.toContain("docker volume rm");
    expect(buildConnectorUpdateCommand("M", "T")).not.toContain("docker volume rm");
  });
  it("is resilient: connector comes up before the guacd/kasm bundle, no busybox, prune first", () => {
    const cmd = buildConnectorUpdateCommand("M", "T");
    expect(cmd).not.toContain("busybox");
    expect(cmd).toContain("docker image prune -f");
    // The connector (access lifeline) is recreated before the heavier bundle so a
    // bundle failure can't leave it down.
    expect(cmd.indexOf("--name access-connector")).toBeLessThan(cmd.indexOf("--name captivo-guacd"));
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
    expect(cmd).toContain("guacamole/guacd:1.6.0");
    expect(cmd).toContain("docker run -d --name access-connector");
  });
  it("update re-provisions guacd", () => {
    const cmd = buildConnectorUpdateCommand(m, t);
    expect(cmd).toContain("--name captivo-guacd");
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
    expect(cmd).toContain("--entrypoint /bin/sh guacamole/guacd:1.6.0");
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
