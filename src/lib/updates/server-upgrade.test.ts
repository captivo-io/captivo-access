import { describe, it, expect } from "vitest";
import { serverUpgradeCommand } from "./server-upgrade";

describe("serverUpgradeCommand", () => {
  it("sets CAPTIVO_VERSION in .env before pulling, because git pull alone never changes it", () => {
    const c = serverUpgradeCommand("2.79.0");
    expect(c).toContain("CAPTIVO_VERSION=2.79.0");
    expect(c.indexOf("CAPTIVO_VERSION")).toBeLessThan(c.indexOf("docker compose -f docker-compose.prod.yml pull"));
    expect(c).toContain("git pull");
    expect(c.endsWith("up -d")).toBe(true);
  });
  it("adds the line when .env has none (older installs)", () => {
    expect(serverUpgradeCommand("2.79.0")).toContain(">> .env");
  });
  it("accepts a leading v", () => {
    expect(serverUpgradeCommand("v2.79.0")).toContain("CAPTIVO_VERSION=2.79.0");
    expect(serverUpgradeCommand("v2.79.0")).not.toContain("=v2");
  });
  it("never puts a non-version string into the shell command", () => {
    const c = serverUpgradeCommand("2.79.0; rm -rf ~");
    expect(c).not.toContain("rm -rf");
    expect(c).not.toContain("sed -i");
  });
});
