---
"@thomasfosterau/effect-document": minor
"@thomasfosterau/effect-ooxml": minor
"@thomasfosterau/effect-csv": minor
---

Worksheets are sparse (#185). **Breaking:** a `SheetRow` now carries its 0-based `index` and holds `IndexedCell`s (`{ col, cell }`) in strictly ascending column order, and a `Worksheet` holds only the rows it has, in strictly ascending `index` order; decoding (and the constructors) reject rows or cells out of order, repeated or at a negative or fractional position. The JSON form changes accordingly: `{ index, cells: [{ col, cell }] }` per row.

New in core: `IndexedCell`, `sheetRow` (a sparse row from a dense array of cells), `sheetExtent`, and the derived dense view `denseRows` (rectangular by default, `{ rectangular: false }` for each row up to its own last cell). Because a sparse sheet's extent can be billions of cells, `denseRows` returns a `Result` and builds the grid only within a budget (`maxCells`, default `DEFAULT_MAX_DENSE_CELLS`, five million; `denseSize` gives the cost), failing with `DenseGridTooLarge` before allocating. `worksheet(...)` still takes a dense grid and keeps every cell given. Text collapse (`blocksToText`) of a worksheet is now the cells it holds, tab-separated, one line per held row, without laying out gaps. Narrowing a worksheet to a prose table lays it out by its dense grid, and drops it with a `sheet.worksheet` loss entry when the grid is over budget.

XLSX: the reader keeps only valued cells at their own row and column, so a sheet with one value at A1 and one at XFD1048576 holds two cells instead of failing or allocating its extent. `<dimension>` is no longer read, and `maxCells` now bounds the valued cells summed over the workbook (it was rows × columns of the dense grids). Trailing blank rows and columns, and blank cells generally, are no longer recovered on read. The writer writes each row and cell at its own index.

CSV: the reader keeps every field (blanks included) as before, now as rows `0..n` with cells `0..m`. The writer writes a gap between cells as an empty field and a row the sheet does not hold as an empty line, within a new `maxFields` budget (default `DEFAULT_MAX_FIELDS`, five million, counting one per line): a sheet whose gaps expand past it fails with a `WriteError` before rendering. `renderCsvStream` writes each streamed row from column 0 to its last cell, ignores its `index`, and fails on a row wider than `maxFields`.
