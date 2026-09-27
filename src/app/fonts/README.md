# Bundled fonts

These four files are vendored so that **building this product needs no network
access for fonts**. They were previously fetched from Google Fonts at build time,
which made a release build fail whenever that fetch did — reported by Turbopack as
a missing module, an error that names the code and not the cause. See
`src/app/fonts.ts` for why the weight lists in that file look redundant (three of
these are variable fonts) and why they must stay as they are.

Subset: `latin` (U+0000–00FF and the usual punctuation ranges), the same subset
requested before. Extended Latin — Turkish `ş ğ ı İ` among others — is **not**
included, as it was not before; such characters fall through to the CSS fallback
stack.

| File | Family | Type | Version | Licence |
|---|---|---|---|---|
| `plex-sans-latin.woff2` | IBM Plex Sans | variable (wght) | Google Fonts v23 | OFL-1.1 |
| `plex-mono-500-latin.woff2` | IBM Plex Mono | static, 500 | Google Fonts v20 | OFL-1.1 |
| `public-sans-latin.woff2` | Public Sans | variable (wght) | Google Fonts v21 | OFL-1.1 |
| `space-grotesk-latin.woff2` | Space Grotesk | variable (wght) | Google Fonts v22 | OFL-1.1 |

## Copyright

- **IBM Plex Sans, IBM Plex Mono** — Copyright © 2017 IBM Corp.
  <https://github.com/IBM/plex>
- **Public Sans** — Copyright © 2015 Impallari Type; Copyright © 2019 United
  States government (USWDS). <https://github.com/uswds/public-sans>
- **Space Grotesk** — Copyright © 2020 Florian Karsten.
  <https://github.com/floriankarsten/space-grotesk>

All four are licensed under the SIL Open Font Licence 1.1, reproduced in
`OFL.txt`. The licence permits bundling and redistribution; it requires that this
notice and the licence text travel with the files, which is what this file is for.

## Updating a face

Request the same family, weights and subset from the Google Fonts CSS2 API with a
browser User-Agent (so it answers with woff2), take the URL from the `@font-face`
block whose `unicode-range` covers `U+0000-00FF`, and replace the file. Keep the
weight lists in `src/app/fonts.ts` matching the weights you request, and record
the new version in the table above.
