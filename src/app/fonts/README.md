# Bundled fonts

These files are vendored so that **building this product needs no network access
for fonts**. They were previously fetched from Google Fonts at build time, which
made a release build fail whenever that fetch did — reported by Turbopack as a
missing module, an error that names the code and not the cause.

Geist and Geist Mono are the Captivo family's faces (Captivo ID serves the same
files) and include Latin Extended, so Turkish letters render in the face. Space
Grotesk is the `latin` subset and is used only for the "Captivo" wordmark.

| File | Family | Type | Licence |
|---|---|---|---|
| `geist-var.woff2` | Geist | variable (wght 100–900) | OFL-1.1 |
| `geist-mono-var.woff2` | Geist Mono | variable (wght 100–900) | OFL-1.1 |
| `space-grotesk-latin.woff2` | Space Grotesk | variable (wght), Google Fonts v22 | OFL-1.1 |

## Copyright

- **Geist, Geist Mono** — Copyright © 2023 Vercel, in collaboration with
  basement.studio; "The Geist Project Authors". <https://github.com/vercel/geist-font>
- **Space Grotesk** — Copyright © 2020 Florian Karsten.
  <https://github.com/floriankarsten/space-grotesk>

All are licensed under the SIL Open Font Licence 1.1, reproduced in `OFL.txt`.
The licence permits bundling and redistribution; it requires that this notice and
the licence text travel with the files, which is what this file is for.

## Updating a face

Geist and Geist Mono are the files Captivo ID serves (`public/fonts` in that
repository); copy them from there so the family stays on one version. Space
Grotesk comes from the Google Fonts CSS2 API with a browser User-Agent (so it
answers with woff2): take the `@font-face` whose `unicode-range` covers
`U+0000-00FF`, and record the new version in the table above.
