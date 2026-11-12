---
"@thomasfosterau/effect-document": minor
---

XLSX reads and writes custom row heights (#66): a `<row>` whose `customHeight` is set becomes a `SheetRow` with its `height` (in points), a row that has only a height is kept as an empty `SheetRow`, and the writer writes `SheetRow.height` as `ht` with `customHeight="1"`, failing with a `WriteError` on a height that is not a finite, non-negative number. A height Excel only computed is not read. A row with only a height counts as one cell toward the reader's `maxCells`.
