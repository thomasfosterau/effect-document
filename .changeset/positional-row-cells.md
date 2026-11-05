---
"@thomasfosterau/effect-document": minor
"@thomasfosterau/effect-csv": minor
"@thomasfosterau/effect-ooxml": minor
"@thomasfosterau/effect-iwork": minor
---

**Breaking:** a worksheet row's cells are positional (#226). `SheetRow.cells` is `ReadonlyArray<SheetCell | undefined>`: the cell at array position `n` is in column `n`, `undefined` is a gap, and the last position holds a cell. In JSON a gap is `null`, so a row is `{ index, cells: [cell, null, cell] }` where it was `{ index, cells: [{ col, cell }, …] }`; documents encoded before this change no longer decode. A position may also be a plain cell: a finite number, string or boolean standing for its unstyled `CellNumber` / `CellText` / `CellBoolean`, written as the bare JSON value (`PlainCell`); read cells through the new `cellOf` / `cellAt`, or `rowEntries`, which always give the node (a plain cell and its node are the same cell, but not `Equal`). The CSV and XLSX readers write plain cells. `IndexedCell` and `indexedCell` are removed. `sheetRow` takes cells with gaps (and copies the array), `sheetRowOf` now takes positional cells and keeps the array it is given, `sparseRow` builds the positional row from `[column, cell]` entries, and the new `rowEntries(row)` lists the cells a row holds with their columns.

A plain value is now no object at all (it was two), so a CSV document of unique numbers is about a quarter of its former size (83 → 21 MB on the benchmark table) and `read` is faster than d3-dsv's `autoType` on every benchmark table; an XLSX document is half the size. Rows remain sparse (a worksheet holds only the rows it has), but a far-right cell costs its row's width: the XLSX reader's `maxCells` now bounds cell positions (each row's width, one past its last valued cell) rather than valued cells, so a sheet with values far apart within a row needs a larger budget than before.
