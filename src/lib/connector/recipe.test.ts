import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildConnectorRunCommand, buildUpdaterRecipe } from "./repair";

// The updater image carries updater/recipe.sh; it must be what runCommand makes,
// or an update from the console would bring a host up differently from the
// command an admin pastes.
const FILE = join(process.cwd(), "updater", "recipe.sh");

describe("updater/recipe.sh", () => {
  const recipe = buildUpdaterRecipe();

  it("is the committed file", () => {
    if (process.env.UPDATE_RECIPE === "1") writeFileSync(FILE, recipe, { mode: 0o755 });
    expect(readFileSync(FILE, "utf8"), "regenerate: UPDATE_RECIPE=1 npx vitest run src/lib/connector/recipe.test.ts").toBe(recipe);
  });

  const section = (name: string) => {
    const from = recipe.indexOf(`\n${name})\n`);
    return recipe.slice(from, recipe.indexOf("\n;;", from));
  };

  it("takes every host fact and image from the environment, never a literal", () => {
    const up = section("update");
    expect(up).not.toContain("ghcr.io");
    expect(up).not.toContain("$(hostname");
    expect(up).not.toContain("PAIR_CODE");
    for (const v of ["MANAGER_URL", "DATAPLANE_URL", "HOST_NAME", "HOST_IP", "HOST_OS", "CONNECTOR_IMAGE", "GUACD_IMAGE", "KASM_IMAGE", "UPDATER_IMAGE"]) {
      expect(up).toContain(`"$${v}"`);
    }
  });

  it("update keeps the data volume; uninstall keeps it only with KEEP_DATA=1", () => {
    expect(section("update")).not.toContain("docker volume rm");
    const un = section("uninstall");
    const keep = un.slice(un.indexOf("then"), un.indexOf("else"));
    expect(keep).not.toMatch(/docker volume rm [^\n]*access_connector_data/);
    expect(keep).toContain("-f /data/token");
    expect(un.slice(un.indexOf("else"))).toMatch(/docker volume rm [^\n]*access_connector_data/);
  });

  it("uninstall removes every container, volume and network the install command creates", () => {
    const install = buildConnectorRunCommand("CODE", "https://m.example", "wss://d.example");
    const un = section("uninstall");
    const named = (re: RegExp) => [...new Set([...install.matchAll(re)].map((m) => m[1]))];
    for (const c of named(/--name (\S+)/g)) expect(un).toMatch(new RegExp(`docker rm -f .*\\b${c}\\b`));
    for (const v of named(/-v ([a-z_]+):\//g)) expect(un).toMatch(new RegExp(`docker volume rm .*\\b${v}\\b`));
    for (const n of named(/docker network create (?:--internal )?(\S+)/g)) expect(un).toMatch(new RegExp(`docker network rm .*\\b${n}\\b`));
  });
});
