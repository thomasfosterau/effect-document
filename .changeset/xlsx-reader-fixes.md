---
"@thomasfosterau/effect-ooxml": patch
---

XLSX reader fixes:

- Chartsheets, dialogsheets and macrosheets no longer fail the read. They come back as empty worksheets tagged `attr.data.kind`.
- Rows and cells without an `r` attribute follow the previous row or cell instead of being placed by ordinal.
- The dependent cells of a shared formula get the master formula translated by their offset, instead of an empty formula.
- Phonetic guide text (`<rPh>`) is no longer concatenated into strings.
- `_xHHHH_` escapes are decoded.
- ISO 8601 `t="d"` cells read as `CellDate`.
