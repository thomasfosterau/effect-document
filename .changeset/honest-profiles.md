---
"@thomasfosterau/effect-document": minor
"@thomasfosterau/effect-ooxml": minor
"@thomasfosterau/effect-pdf": minor
"@thomasfosterau/effect-rtf": minor
"@thomasfosterau/effect-csv": patch
"@thomasfosterau/effect-iwork": patch
---

Profiles no longer overclaim (#109).

`Format<R, W = R>` now has separate `readProfile` and `writeProfile` fields in place of `profile`. A format's write profile is what its writer preserves through `read(write(doc))`, and `convert` narrows to it, so anything a writer would silently drop or downgrade is now reported in the loss report.

Trimmed to what round-trips today:

- **XLSX:** new `Xlsx` (write) and `XlsxRead` profiles replace the full `Spreadsheet` profile. Columns, merges, styles, rich text, attributes and dates are not preserved.
- **DOCX:** code blocks, block quotes, divs, line blocks, rules, inline code and quotations are not preserved.
- **PPTX and RTF:** headers are not preserved.
- **PDF:** new `PdfWrite` profile. Block quotes, rules, line breaks, underline and strikeout are not preserved.

A new integration test round-trips a sample of every write-profile feature for every format, so profile drift fails CI.
