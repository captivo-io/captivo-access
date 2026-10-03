/**
 * A shell whose links the stylesheet HIDES must render the replacement it styles.
 *
 * WHAT WAS WRONG. globals.css hides `.tn-primary` below 900px and shows
 * `.tn-burger` plus `.tn-scrim` / `.tn-drawer` in its place. The tenant console's
 * TopNav renders all three; the platform console's header was written from it and
 * rendered only the link row, so on a phone all six platform destinations --
 * Overview, Tenants, Activity, Admins, Jobs, Settings -- disappeared and nothing
 * replaced them. The CSS was ready; the markup was not.
 *
 * The identical defect had just been found in the other repository's marketing bar,
 * which is why this is pinned as a rule rather than fixed as an instance.
 *
 * WHY A SCAN DID NOT FIND IT. An audit looking for bad patterns PRESENT -- a clipping
 * table, a fixed width, a grid that will not collapse -- cannot see a MISSING
 * element. This asserts the pairing instead: for each class the stylesheet hides at a
 * breakpoint, whoever renders it also renders what is shown in its place.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const ROOT = process.cwd();
const CSS = readFileSync(join(ROOT, "src/app/globals.css"), "utf8");

const SOURCES = execFileSync("git", ["ls-files", "src"], { encoding: "utf8", cwd: ROOT })
  .split("\n")
  .filter((f) => f.endsWith(".tsx") && !f.includes(".test."));

const code = (f: string) =>
  readFileSync(join(ROOT, f), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

/**
 * Each row the stylesheet hides on small screens, with what it shows instead.
 * Written out because the pairing is a decision, not something inferable: the CSS
 * says `display:none` here and `display:flex` there, never which replaces which.
 */
const PAIRS = [
  { hidden: "tn-primary", replacement: ["tn-burger", "tn-drawer"] },
  { hidden: "vp-navlinks", replacement: ["vp-burger", "vp-mmenu"] },
] as const;

describe("mobil navigasyon", () => {
  it("bu testin dayanagi: CSS gercekten gizliyor ve yerine koyuyor", () => {
    // Without this the pairs could name classes the stylesheet never touches, and
    // every assertion below would be about nothing.
    for (const p of PAIRS) {
      expect(CSS, `.${p.hidden} kucuk ekranda gizlenmiyor`).toMatch(
        new RegExp(`\\.${p.hidden}[^{]*\\{[^}]*display:\\s*none`),
      );
      for (const r of p.replacement) {
        expect(CSS, `.${r} stillenmemis`).toContain(`.${r}`);
      }
    }
    expect(SOURCES.length, "kaynak dosya bulunamadi").toBeGreaterThan(50);
  });

  /**
   * The replacement may live in a component the file IMPORTS rather than in the file
   * itself -- the visitor portal's layout renders the link row and pulls the burger
   * in from _nav/portal-mobile-nav. Requiring both in one file failed on exactly
   * that, which is the guard being right about the rule and wrong about where to
   * look. So a local import is followed one level, which is as far as this pattern
   * ever goes here.
   */
  const withImports = (f: string): string => {
    const src = code(f);
    const dir = f.slice(0, f.lastIndexOf("/"));
    let merged = src;
    for (const m of src.matchAll(/from\s+"(\.[^"]+)"/g)) {
      const rel = m[1].replace(/^\.\//, "");
      for (const cand of SOURCES) {
        if (cand === `${dir}/${rel}.tsx` || cand === `${dir}/${rel}/index.tsx`) {
          merged += code(cand);
        }
      }
    }
    return merged;
  };

  it.each(PAIRS)("$hidden render eden dosya karsiligini da render ediyor", (pair) => {
    const offenders: string[] = [];
    for (const f of SOURCES) {
      if (!code(f).includes(`"${pair.hidden}"`)) continue;
      const reachable = withImports(f);
      const missing = pair.replacement.filter((r) => !reachable.includes(r));
      if (missing.length) offenders.push(`${f}: ${missing.join(", ")} yok`);
    }
    expect(
      offenders,
      "CSS bu satiri gizliyor — gizleyen sayfanin yerine koyacagi da olmali",
    ).toEqual([]);
  });

  it("her hamburger kontrol ettigi paneli adiyla soyluyor", () => {
    // aria-expanded alone says "this opens something"; aria-controls says what.
    const offenders: string[] = [];
    for (const f of SOURCES) {
      const src = code(f);
      for (const m of src.matchAll(/<button[^>]*className="(tn-burger|vp-burger)"[^>]*>/g)) {
        if (!m[0].includes("aria-controls")) offenders.push(`${f}: .${m[1]} aria-controls yok`);
        if (!m[0].includes("aria-expanded")) offenders.push(`${f}: .${m[1]} aria-expanded yok`);
      }
    }
    expect(offenders, "hamburger aria baglarini tasimiyor").toEqual([]);
  });

  it("aria-controls'un isaret ettigi id GERCEKTEN render ediliyor", () => {
    // A dangling idref is the shape this nearly shipped with: the portal's menu was
    // rendered only while open, so the reference pointed at nothing when closed.
    const offenders: string[] = [];
    for (const f of SOURCES) {
      const src = code(f);
      for (const m of src.matchAll(/aria-controls="([^"]+)"/g)) {
        if (!src.includes(`id="${m[1]}"`)) offenders.push(`${f}: #${m[1]} yok`);
      }
    }
    expect(offenders, "aria-controls bos bir id'ye isaret ediyor").toEqual([]);
  });
});
