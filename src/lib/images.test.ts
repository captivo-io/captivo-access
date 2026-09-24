import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "fs";
import { execSync } from "child_process";
import path from "path";
import { IMAGE_OWNER, IMAGE_PREFIX, PUBLISHED_IMAGES, accessImage } from "./images";

const ROOT = path.join(__dirname, "..", "..");
const read = (p: string) => (existsSync(path.join(ROOT, p)) ? readFileSync(path.join(ROOT, p), "utf-8") : null);

/**
 * The registry namespace is the same everywhere an operator can see it.
 *
 * It is not only a code constant: it appears in the two compose files an
 * operator runs, in the install and quickstart docs they copy commands from, and
 * in the connector command the panel generates. When this repository moved to
 * the captivo-io organisation the string had to change in nine files at once --
 * and a string spread over nine files is one that gets half-changed next time.
 *
 * Compose files and markdown cannot import the constant, so this test is the
 * join. A half-change fails the build instead of shipping an install command
 * that pulls an image nobody published.
 */
const OPERATOR_FACING = [
  "deploy/docker-compose.prod.yml",
  "deploy-saas/docker-compose.saas.yml",
  "README.md",
  "docs/install.md",
  "docs/quickstart.md",
  "connector/README.md",
];

describe("image namespace", () => {
  it("finds the operator-facing files it is meant to check", () => {
    // Guards the paths: a moved file would make the assertions below pass over
    // nothing, which is how a namespace drifts unnoticed.
    for (const f of OPERATOR_FACING) expect(read(f), f).not.toBeNull();
  });

  it("no operator-facing file names the OLD namespace", () => {
    const stale = OPERATOR_FACING.filter((f) => read(f)!.includes("ghcr.io/kurtserdar/"));
    expect(stale).toEqual([]);
  });

  it("nothing outside the historical plan documents names the old owner", () => {
    // Wider than the list above on purpose. The clone links were caught by
    // grepping the docs; a FIFTH reference lived in shipped code -- the update
    // check queried api.github.com/repos/kurtserdar/... -- plus a deploy README
    // and CONTRIBUTING.md. Those resolve today only because GitHub redirects a
    // transferred repository, which is a dependency on a redirect rather than a
    // correct address.
    //
    // The file list comes from GIT, not from walking the disk: a filesystem walk
    // also found a stale worktree under .wt/ that is gitignored and not part of
    // the repository at all. Asking git is the only list that cannot drift from
    // what is actually committed.
    //
    // docs/superpowers is exempt -- those are records of what was done on a
    // given day, not instructions. This file is exempt because it has to name
    // the string it forbids.
    const tracked = execSync("git ls-files", { cwd: ROOT, encoding: "utf-8" })
      .split("\n")
      .filter(Boolean)
      .filter((f) => !f.startsWith("docs/superpowers/"))
      .filter((f) => f !== "src/lib/images.test.ts")
      .filter((f) => /\.(ts|tsx|md|yml|yaml|sh|json)$/.test(f));
    expect(tracked.length, "git ls-files bos").toBeGreaterThan(100);

    const stale = tracked.filter((f) => readFileSync(path.join(ROOT, f), "utf-8").includes("kurtserdar"));
    expect(stale).toEqual([]);
  });

  it("no operator-facing file names the OLD repository address", () => {
    // Clone and release links pointed at the personal account for four more
    // commits after the move. They resolve today only because GitHub redirects
    // a transferred repository -- and a clone from the old URL leaves that
    // address as the reader's `origin`, which stops working the day anyone
    // creates a repository by that name again.
    const stale = OPERATOR_FACING.filter((f) => read(f)!.includes("github.com/kurtserdar/"));
    expect(stale).toEqual([]);
  });

  it("every ghcr reference uses the owner the constant declares", () => {
    for (const f of OPERATOR_FACING) {
      const owners = [...read(f)!.matchAll(/ghcr\.io\/([a-z0-9-]+)\//g)].map((m) => m[1]);
      for (const owner of owners) expect(owner, `${f}: ${owner}`).toBe(IMAGE_OWNER);
    }
  });

  it("the published image list matches the workflow's build matrix", () => {
    // The workflow derives the namespace from github.repository_owner, so it
    // needs no edit when the owner changes -- but the image NAMES are listed
    // there and here, and one added to only one side is invisible until an
    // operator pulls something nobody published.
    const wf = read(".github/workflows/publish.yml");
    expect(wf, "publish.yml not found").not.toBeNull();
    const matrix = [...wf!.matchAll(/^\s+- image:\s*([a-z-]+)/gm)].map((m) => m[1]);
    expect(matrix.length).toBeGreaterThan(0);
    expect([...matrix].sort()).toEqual([...PUBLISHED_IMAGES].sort());
  });

  it("the workflow derives the namespace from the OWNER, never hardcodes it", () => {
    // Hardcoded, a future transfer would publish under the old owner while every
    // reference here pointed at the new one.
    const wf = read(".github/workflows/publish.yml")!;
    expect(wf).toContain("ghcr.io/${{ github.repository_owner }}/captivo-access-");
    expect(wf).not.toContain("ghcr.io/kurtserdar");
  });

  it("both compose files fall back to the version this checkout ships", () => {
    // The fallback is a literal in each compose file, and a literal nobody bumps
    // goes stale in silence: it had drifted to 1.9.0 in one file and 1.10.0 in
    // the other while the release was 1.14.0. That was invisible only because the
    // old registry namespace still held every old tag -- the moment the images
    // moved to a fresh namespace, a default install asked for a version never
    // published there and failed. This test is what makes the staleness loud.
    const version = read("VERSION")!.trim();
    expect(version, "VERSION dosyasi bos").toMatch(/^\d+\.\d+\.\d+$/);

    for (const f of ["deploy/docker-compose.prod.yml", "deploy-saas/docker-compose.saas.yml"]) {
      const fallbacks = [...read(f)!.matchAll(/CAPTIVO_VERSION:-([0-9.]+)/g)].map((m) => m[1]);
      expect(fallbacks.length, `${f}: fallback bulunamadi`).toBeGreaterThan(0);
      for (const v of fallbacks) expect(v, `${f}: ${v} != ${version}`).toBe(version);
    }
  });

  it("a fresh install pins the version rather than trusting the fallback", () => {
    // Belt and braces: even if a fallback goes stale again, setup.sh writes the
    // shipped version into the generated .env, so a first install asks for an
    // image that exists.
    const setup = read("deploy/setup.sh")!;
    expect(setup).toContain("CAPTIVO_VERSION=$VERSION");
    expect(setup).toMatch(/VERSION="\$\(cat .*VERSION/);
  });

  it("accessImage builds a fully qualified reference", () => {
    expect(accessImage("connector")).toBe(`${IMAGE_PREFIX}-connector:latest`);
    expect(accessImage("manager", "1.14.0")).toBe(`${IMAGE_PREFIX}-manager:1.14.0`);
  });
});
