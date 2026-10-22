---
"@thomasfosterau/effect-csv": patch
---

Fix CSV writer data loss and add output options.

- A row holding a single blank cell is written as `""` instead of an empty line, which the reader dropped.
- Number cells are written as their shortest round-trip decimal, never in exponent form (`1e21` is written as `1000000000000000000000`). Override with `formatNumber`; `formatCsvNumber` is the default.
- Fields with leading or trailing whitespace are quoted, and so are fields starting with the new `lineCommentMarker` option, so they read back intact.
- New `escapeFormulae` option guards against CSV (formula) injection: text starting with `=`, `+`, `-`, `@`, a tab or a CR is prefixed with `'` and quoted. Off by default.
- New `quoting` option: `minimal` (the default), `all`, `nonNumeric` or `none`. With `none`, writing fails with a `WriteError` if a field can't be read back without quotes.
- New `bom`, `headers` and `padRows` options.
- New `renderCsvStream` renders a `Stream` of `SheetRow`s to a `Stream` of CSV text, one chunk per row.
- The line break is documented as the dialect's `linebreak` (LF by default). The new `Rfc4180Dialect` writes CRLF.
