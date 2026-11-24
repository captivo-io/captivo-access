import { describe, expect, it } from "vitest";
import { connectorServes, platformLabel, STANDALONE_ACCESS_MODES } from "./platform";

describe("connectors installed as a program", () => {
  it("serve web apps, databases, clusters and tunnels, not the engines' resources", () => {
    expect([...STANDALONE_ACCESS_MODES].sort()).toEqual(["DATABASE", "KUBERNETES", "TRANSPARENT", "TUNNEL"]);
    for (const m of STANDALONE_ACCESS_MODES) expect(connectorServes({ platform: "windows" }, m)).toBe(true);
    expect(connectorServes({ platform: "windows" }, "GATEWAY")).toBe(false);
    expect(connectorServes({ platform: "linux" }, "ISOLATED")).toBe(false);
  });
  it("leave the Docker image unrestricted", () => {
    expect(connectorServes({ platform: null }, "GATEWAY")).toBe(true);
    expect(connectorServes({}, "ISOLATED")).toBe(true);
  });
  it("are named for people", () => {
    expect(platformLabel("windows")).toBe("Windows");
    expect(platformLabel("linux")).toBe("Linux service");
    expect(platformLabel(null)).toBeNull();
  });
});
