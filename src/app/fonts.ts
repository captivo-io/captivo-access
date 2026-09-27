/**
 * The four faces this product renders, loaded from files IN THIS REPOSITORY.
 *
 * WHY NOT next/font/google. That loader downloads the font at BUILD time, so a
 * release build depended on fonts.googleapis.com answering. When it did not,
 * Turbopack reported it as `Module not found: Can't resolve
 * '@vercel/turbopack-next/internal/font/google/font'` -- an error that points at
 * the code and says nothing about the network. On 2026-09-27 it failed two of six
 * builds (the image publish and CI, on the same commit that then passed on a
 * re-run), and the failure rate rises with release cadence, which is exactly when
 * a blocked build costs most. The build no longer touches the network for fonts.
 *
 * THE WEIGHT LISTS ARE DELIBERATE, NOT TIDINESS. Three of these files are
 * VARIABLE fonts, and Google serves one file for every weight of them -- which is
 * why next/font/google emitted several @font-face rules, one per requested weight,
 * all pointing at the same file. Declaring a weight RANGE here instead would be
 * the obvious-looking translation and would change what the pages render: the
 * stylesheet asks for weights that are not in these lists (`640` for the display
 * face, `400`/`600`/`700` for the mono), and today the browser rounds or
 * synthesises those. A range would resolve them to real instances -- arguably
 * better type, but a visible change, and this change exists to remove a network
 * dependency without touching a pixel. So each list mirrors exactly the weights
 * next/font/google was asked for.
 *
 * Subset: `latin`, matching what was requested before. Turkish letters
 * (ş/ğ/ı/İ) live in `latin-ext` and were not loaded before either, so they still
 * fall through to the CSS fallback stack -- unchanged, and worth fixing on its
 * own rather than inside a swap that is supposed to change nothing.
 *
 * Licences: SIL Open Font Licence 1.1 for all four. See fonts/README.md.
 */
import localFont from "next/font/local";

// Every path below is a LITERAL, and the weight entries are written out rather
// than generated. next/font/local resolves these at compile time, so a computed
// path -- `${DIR}/x.woff2`, or entries built with .map() -- is not a path it can
// see, and the build fails with a module-not-found that names this file.

// IBM Plex Sans, one variable file, asked for at 400/600/700.
export const plexSans = localFont({
  src: [
    { path: "./fonts/plex-sans-latin.woff2", weight: "400", style: "normal" },
    { path: "./fonts/plex-sans-latin.woff2", weight: "600", style: "normal" },
    { path: "./fonts/plex-sans-latin.woff2", weight: "700", style: "normal" },
  ],
  variable: "--font-plex-sans",
  display: "swap",
});

// IBM Plex Mono is the one STATIC file here: Google serves a separate file per
// weight for it, and only 500 was ever requested.
export const plexMono = localFont({
  src: [{ path: "./fonts/plex-mono-500-latin.woff2", weight: "500", style: "normal" }],
  variable: "--font-plex-mono",
  display: "swap",
});

// Public Sans, one variable file, asked for at 400/500/600/700/800.
export const publicSans = localFont({
  src: [
    { path: "./fonts/public-sans-latin.woff2", weight: "400", style: "normal" },
    { path: "./fonts/public-sans-latin.woff2", weight: "500", style: "normal" },
    { path: "./fonts/public-sans-latin.woff2", weight: "600", style: "normal" },
    { path: "./fonts/public-sans-latin.woff2", weight: "700", style: "normal" },
    { path: "./fonts/public-sans-latin.woff2", weight: "800", style: "normal" },
  ],
  variable: "--font-public-sans",
  display: "swap",
});

// Space Grotesk, one variable file, asked for at 600 only.
export const grotesk = localFont({
  src: [{ path: "./fonts/space-grotesk-latin.woff2", weight: "600", style: "normal" }],
  variable: "--font-grotesk",
  display: "swap",
});
