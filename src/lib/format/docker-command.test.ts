import { describe, it, expect } from "vitest";
import { formatDockerRun, formatShellCommand } from "./docker-command";

const CMD =
  "docker run -d --name access-connector --restart unless-stopped -e MANAGER_URL=https://m -e PAIR_CODE=X -v access_connector_data:/data ghcr.io/captivo-io/captivo-access-connector:latest";

const EXPECTED = `docker run -d \\
  --name access-connector \\
  --restart unless-stopped \\
  -e MANAGER_URL=https://m \\
  -e PAIR_CODE=X \\
  -v access_connector_data:/data \\
  ghcr.io/captivo-io/captivo-access-connector:latest`;

describe("formatDockerRun", () => {
  it("pretty-prints a docker run one-liner into multiline continuations", () => {
    expect(formatDockerRun(CMD)).toBe(EXPECTED);
  });
  it("keeps boolean flags on line 1 and groups value flags with their values", () => {
    expect(formatDockerRun("docker run -d --name x -e A=1 image:tag")).toBe(
      "docker run -d \\\n  --name x \\\n  -e A=1 \\\n  image:tag",
    );
  });
  it("returns a non-docker string unchanged", () => {
    expect(formatDockerRun("echo hello world")).toBe("echo hello world");
    expect(formatDockerRun("  ")).toBe("  ");
  });
});

describe("formatShellCommand", () => {
  it("splits a compound command into one step per line, keeping separators", () => {
    const out = formatShellCommand("docker network create net && docker rm -f x >/dev/null 2>&1; docker pull img");
    expect(out).toBe("docker network create net &&\ndocker rm -f x >/dev/null 2>&1 ;\ndocker pull img");
  });
  it("expands a docker run step's flags but leaves a quoted step on one line", () => {
    const guacd = "docker run -d --name captivo-guacd --entrypoint /bin/sh guacamole/guacd:1.6.0 -c 'guacd -f 2>&1 | tee /log'";
    const conn = "docker run -d --name access-connector -e MANAGER_URL=https://m image:tag";
    const out = formatShellCommand(`${guacd} && ${conn}`);
    // quoted guacd step stays intact on one line (with the separator)
    expect(out).toContain(`${guacd} &&`);
    // connector step is flag-expanded
    expect(out).toContain("docker run -d \\\n  --name access-connector");
  });
  it("passes a lone docker run through to formatDockerRun", () => {
    expect(formatShellCommand("docker run -d --name x -e A=1 image:tag")).toBe(
      "docker run -d \\\n  --name x \\\n  -e A=1 \\\n  image:tag",
    );
  });
  it("returns whitespace-only input unchanged", () => {
    expect(formatShellCommand("  ")).toBe("  ");
  });
});
