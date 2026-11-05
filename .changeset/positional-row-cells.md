---
"@thomasfosterau/effect-document": minor
"@thomasfosterau/effect-csv": minor
"@thomasfosterau/effect-ooxml": minor
"@thomasfosterau/effect-iwork": minor
---

**Breaking:** a worksheet row's cells are positional (#226). `SheetRow.cells` is `ReadonlyArray<SheetCell | undefined>`: the cell at array position `n` is in column `n`, `undefined` is a gap, and the last position holds a cell. In JSON a gap is `null`, so a row is `{ index, cells: [cell, null, cell] }` where it was `{ index, cells: [{ col, cell }, …] }`; documents encoded before this change no longer decode. `IndexedCell` and `indexedCell` are removed. `sheetRow` takes cells with gaps (and copies the array), `sheetRowOf` now takes positional cells and keeps the array it is given, `sparseRow` builds the positional row from `[column, cell]` entries, and the new `rowEntries(row)` lists the cells a row holds with their columns.

A cell is now one object rather than two, so a CSV document of unique numbers is about a third smaller and faster to read. Rows remain sparse (a worksheet holds only the rows it has), but a far-right cell costs its row's width: the XLSX reader's `maxCells` now bounds cell positions (each row's width, one past its last valued cell) rather than valued cells, so a sheet with values far apart within a row needs a larger budget than before.
