---
"@thomasfosterau/effect-ooxml": patch
"@thomasfosterau/effect-document": patch
---

XLSX writer: emit files Excel opens without repair.

- `NaN` and `±Infinity` are written as `#NUM!` error cells.
- Characters that are invalid in XML 1.0 are `_xHHHH_`-encoded, and a literal `_xHHHH_` is escaped with `_x005F_`.
- Sheet names are sanitised deterministically: invalid characters, empty names, `History`, more than 31 characters, and case-insensitive duplicates. See `sanitizeSheetNames`.
- A leading `=` is stripped from formulas. `CellFormula.formula` is documented as never including it.
- `<calcPr fullCalcOnLoad="1"/>` is emitted when a formula has no cached result.
- `sst@count` is now the reference count, with `uniqueCount` as the distinct count.
- `docProps/core.xml` and `docProps/app.xml` are written.
