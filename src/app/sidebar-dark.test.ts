import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The sidebar is dark in both themes (Captivo Portal's is too). It gets there by
 * re-declaring the dark palette on `.sb`, so a token added to the dark theme and
 * forgotten here would leave the sidebar half light. Compare the two blocks.
 */
const CSS = readFileSync(join(__dirname, "globals.css"), "utf8");

function block(selector: string): string {
  const start = CSS.indexOf(selector);
  expect(start, selector).toBeGreaterThan(-1);
  return CSS.slice(start, CSS.indexOf("}", start));
}

function tokens(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of text.matchAll(/(--[a-z0-9-]+):([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}

describe("the sidebar is dark in both themes", () => {
  const dark = tokens(block(':root[data-theme="dark"]{'));
  const sb = tokens(block("\n.sb{--side"));

  it("its colour tokens equal the dark theme's", () => {
    for (const k of ["--side", "--card", "--field", "--ink", "--ink-rgb", "--muted", "--p", "--p-rgb", "--a", "--ok", "--ok-rgb", "--warn", "--warn-rgb", "--bad", "--bad-rgb", "--bg", "--bg-rgb"]) {
      expect(sb[k], k).toBe(dark[k]);
    }
  });

  it("its text colour is the dark ink value itself, not a var() chain resolved at :root", () => {
    expect(sb["--fg"]).toBe(dark["--ink"]);
  });
});
