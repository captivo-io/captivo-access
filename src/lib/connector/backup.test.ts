import { describe, expect, it } from "vitest";
import { buildFullBackupCommand, buildFullRestoreCommand, buildKeysBackupCommand, buildKeysRestoreCommand } from "./backup";
import { formatShellCommand } from "@/lib/format/docker-command";

describe("connector backup commands", () => {
  it("backs up both keys from the running connector, vault key optional for older ones", () => {
    const c = buildKeysBackupCommand();
    expect(c).toContain("docker cp access-connector:/data/recording.key captivo-connector-keys/");
    expect(c).toMatch(/docker cp access-connector:\/data\/vault\.key captivo-connector-keys\/ 2>\/dev\/null \|\| echo/);
    expect(c).toContain("chmod 700 captivo-connector-keys");
  });

  it("archives the data volume read-only and leaves the sign-in token out", () => {
    const c = buildFullBackupCommand();
    expect(c).toContain("-v access_connector_data:/data:ro");
    expect(c).toContain("--exclude=./token");
    expect(c).toContain("captivo-connector-$(date +%F).tar.gz");
  });

  it("restores into the data volume owned by the connector's user, stopping it first", () => {
    for (const c of [buildKeysRestoreCommand(), buildFullRestoreCommand("x.tar.gz")]) {
      expect(c.startsWith("docker stop access-connector")).toBe(true);
      expect(c).toContain("-v access_connector_data:/data ");
      expect(c).toContain("chown");
      expect(c).toContain("10001:10001");
      expect(c).toContain("docker start access-connector");
    }
    expect(buildFullRestoreCommand("x.tar.gz")).toContain("tar -xzf /backup/x.tar.gz -C /data");
  });

  it("formats for display without losing anything", () => {
    for (const c of [buildKeysBackupCommand(), buildFullBackupCommand(), buildKeysRestoreCommand(), buildFullRestoreCommand()]) {
      expect(formatShellCommand(c).replace(/\s*\\\n\s*/g, " ").replace(/\n/g, " ").replace(/\s+/g, " ")).toContain("access");
    }
  });
});
