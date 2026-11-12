---
"@thomasfosterau/effect-document": minor
---

XLSX reads and writes rich shared strings: a cell whose runs carry bold, italic, underline, strikethrough or superscript / subscript reads as a `CellRichText` and is written back as formatted runs, so the `Xlsx` profile gains `cell.richText` and those inline marks. Fonts, sizes and colours are not kept.
