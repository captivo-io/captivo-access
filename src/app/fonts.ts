/**
 * The faces this product renders, loaded from files IN THIS REPOSITORY.
 *
 * WHY NOT next/font/google. That loader downloads the font at BUILD time, so a
 * release build depended on fonts.googleapis.com answering. When it did not,
 * Turbopack reported it as `Module not found: Can't resolve
 * '@vercel/turbopack-next/internal/font/google/font'` -- an error that points at
 * the code and says nothing about the network. On 2026-09-27 it failed two of six
 * builds. The build no longer touches the network for fonts.
 *
 * Geist and Geist Mono are variable fonts declared with their full weight range.
 * Space Grotesk is the `latin` subset, enough for the "Captivo" wordmark, the
 * only place it is used.
 *
 * Licences: SIL Open Font Licence 1.1. See fonts/README.md.
 */
import localFont from "next/font/local";

// Every path below is a LITERAL, and the weight entries are written out rather
// than generated. next/font/local resolves these at compile time, so a computed
// path -- `${DIR}/x.woff2`, or entries built with .map() -- is not a path it can
// see, and the build fails with a module-not-found that names this file.

// Geist and Geist Mono, the faces the rest of the Captivo family uses (Captivo
// ID serves these same files). Both are variable fonts with the full Latin
// Extended set, so Turkish names and hosts render in the face, not a fallback.
export const geist = localFont({
  src: [{ path: "./fonts/geist-var.woff2", weight: "100 900", style: "normal" }],
  variable: "--font-geist",
  display: "swap",
});

export const geistMono = localFont({
  src: [{ path: "./fonts/geist-mono-var.woff2", weight: "100 900", style: "normal" }],
  variable: "--font-geist-mono",
  display: "swap",
});

// Space Grotesk, one variable file, asked for at 600 only.
export const grotesk = localFont({
  src: [{ path: "./fonts/space-grotesk-latin.woff2", weight: "600", style: "normal" }],
  variable: "--font-grotesk",
  display: "swap",
});
