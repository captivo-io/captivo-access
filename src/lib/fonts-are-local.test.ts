import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";

/**
 * The build must not fetch fonts.
 *
 * next/font/google downloads at BUILD time, so a release depended on
 * fonts.googleapis.com answering -- and when it did not, Turbopack reported a
 * missing internal module, which reads as a code fault. Two of six builds failed
 * that way on 2026-09-27. A reintroduced `next/font/google` import would restore
 * the dependency silently: everything still builds, on the days Google answers.
 */

/** Every .ts/.tsx under dir, recursively. A new directory cannot hide an import. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) {
      if (e.name === "generated" || e.name === "node_modules") continue;
      out.push(...sourceFiles(p));
    } else if (/\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

/**
 * Blanks comments and string/template literals, keeping import statements intact.
 * Written as a tiny scanner rather than a regex because `//` inside a URL string
 * would otherwise swallow the rest of its line -- and an import sharing that line
 * would vanish from the scan, which is the failure mode this guard exists to stop.
 */
function stripCommentsAndStrings(src: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const two = src.slice(i, i + 2);
    if (two === "//") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (two === "/*") {
      i += 2;
      while (i < src.length && src.slice(i, i + 2) !== "*/") i++;
      i += 2;
      continue;
    }
    const q = src[i];
    if (q === '"' || q === "'" || q === "`") {
      // Keep the quotes and the first character so `from "next/font/google"` is
      // still recognisable as an import while prose inside strings is not.
      out += q;
      i++;
      let body = "";
      while (i < src.length && src[i] !== q) {
        if (src[i] === "\\") i++;
        body += src[i];
        i++;
      }
      out += body.startsWith("next/font/") ? body : "";
      out += q;
      i++;
      continue;
    }
    out += src[i];
    i++;
  }
  return out;
}

describe("fonts are bundled, not fetched", () => {
  it("no source file imports the Google font loader", () => {
    // Scans STRIPPED source. The string itself appears in prose -- fonts.ts
    // explains why it is gone, and this file names it twice -- so a guard that
    // greps the raw text fails on its own documentation and gets deleted.
    const offenders = sourceFiles("src").filter((f) =>
      /(?:from|require\s*\()\s*["'`]next\/font\/google/.test(stripCommentsAndStrings(readFileSync(f, "utf8"))),
    );
    expect(offenders, "the build fetches fonts again").toEqual([]);
  });

  it("every face the layout declares has its file on disk", () => {
    const mod = readFileSync("src/app/fonts.ts", "utf8");
    const referenced = [...mod.matchAll(/["']\.\/fonts\/([\w.-]+\.woff2)["']/g)].map((m) => m[1]);
    expect(referenced.length, "no font files referenced").toBeGreaterThan(0);
    for (const file of new Set(referenced)) {
      expect(existsSync(`src/app/fonts/${file}`), `missing ${file}`).toBe(true);
      // A truncated or HTML-error download still satisfies existsSync.
      const head = readFileSync(`src/app/fonts/${file}`).subarray(0, 4).toString("latin1");
      expect(head, `${file} is not a woff2`).toBe("wOF2");
    }
  });

  it("carries the licence the bundled faces require", () => {
    const ofl = readFileSync("src/app/fonts/OFL.txt", "utf8");
    expect(ofl).toContain("SIL OPEN FONT LICENSE Version 1.1");
    const readme = readFileSync("src/app/fonts/README.md", "utf8");
    // Redistribution obligation: each family's copyright holder must be named.
    for (const holder of ["IBM Corp", "Impallari Type", "Florian Karsten"]) {
      expect(readme, `README does not credit ${holder}`).toContain(holder);
    }
    // Every shipped file must appear in the README table, or it travels uncredited.
    for (const f of readdirSync("src/app/fonts").filter((f) => f.endsWith(".woff2"))) {
      expect(readme, `${f} is shipped but not listed`).toContain(f);
    }
  });
});
