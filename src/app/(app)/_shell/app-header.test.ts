import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ACCESS_DOCS_URL } from "@/lib/docs-url";

const header = readFileSync(join(__dirname, "app-header.tsx"), "utf8");

describe("console header documentation link", () => {
  it("leads to the Access documentation on the public site", () => {
    const u = new URL(ACCESS_DOCS_URL);
    expect(u.origin).toBe("https://captivo.io");
    expect(u.pathname).toBe("/en/docs");
    expect(u.hash).toBe("#access");
  });

  it("opens in a new tab without handing over the opener", () => {
    expect(header).toContain("href={ACCESS_DOCS_URL}");
    expect(header).toContain('target="_blank"');
    expect(header).toMatch(/rel="noopener noreferrer"/);
  });

  it("is shown to every role: it is not behind a model flag", () => {
    // The link sits directly after the flag-gated blocks, introduced by its own comment, not inside one.
    expect(header).toMatch(/\)\}\s*\{\/\* Every signed-in user[^]*?\*\/\}\s*<a\s/);
  });
});
