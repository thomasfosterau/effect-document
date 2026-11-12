---
"@thomasfosterau/effect-document": minor
---

XLSX reads and writes column widths (`<cols>`, as `Worksheet.columns`) and merged ranges (`<mergeCells>`, as `Worksheet.merges`), so the `Xlsx` profile now includes `sheet.columns` and `sheet.merges` and a conversion keeps them (#66). The writer writes consecutive columns of one width as one `<col>` and fails with a `WriteError` on a merge whose corners are not cell positions; the reader fails with a `ParseError` on a merge `ref` that is not an A1 range. New: `withSheetLayout`, a worksheet with its columns and merges set and its rows kept unchecked.
