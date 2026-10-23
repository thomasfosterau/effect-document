---
"@thomasfosterau/effect-ooxml": patch
---

XLSX reader: `maxCells` now bounds the cells of the whole workbook rather than each worksheet, so a small file with many sheets (or many `<sheet>` entries pointing at one worksheet part, each widened by its `<dimension>` hint) can no longer allocate sheets × `maxCells` blank cells. A sheet whose extent exceeds what the sheets before it left fails with a `ParseError`, and a `<dimension>` hint that would exceed it is ignored.
