import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "fs";
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

  it("accessImage builds a fully qualified reference", () => {
    expect(accessImage("connector")).toBe(`${IMAGE_PREFIX}-connector:latest`);
    expect(accessImage("manager", "1.14.0")).toBe(`${IMAGE_PREFIX}-manager:1.14.0`);
  });
});
