---
"@thomasfosterau/effect-document": minor
"@thomasfosterau/effect-ooxml": minor
"@thomasfosterau/effect-csv": minor
---

Worksheets are sparse (#185). **Breaking:** a `SheetRow` now carries its 0-based `index` and holds `IndexedCell`s (`{ col, cell }`) in strictly ascending column order, and a `Worksheet` holds only the rows it has, in strictly ascending `index` order; decoding (and the constructors) reject rows or cells out of order, repeated or at a negative or fractional position. The JSON form changes accordingly: `{ index, cells: [{ col, cell }] }` per row.

New in core: `IndexedCell`, `sheetRow` (a sparse row from a dense array of cells), `sheetExtent`, and the derived dense views `denseCells` and `denseRows` (rectangular by default, `{ rectangular: false }` for each row up to its own last cell). `worksheet(...)` still takes a dense grid and keeps every cell given. Text collapse and narrowing a worksheet to a prose table lay it out by its dense grid.

XLSX: the reader keeps only valued cells at their own row and column, so a sheet with one value at A1 and one at XFD1048576 holds two cells instead of failing or allocating its extent. `<dimension>` is no longer read, and `maxCells` now bounds the valued cells summed over the workbook (it was rows × columns of the dense grids). Trailing blank rows and columns, and blank cells generally, are no longer recovered on read. The writer writes each row and cell at its own index.

CSV: the reader keeps every field (blanks included) as before, now as rows `0..n` with cells `0..m`. The writer writes a gap between cells as an empty field and a row the sheet does not hold as an empty line; `renderCsvStream` writes each streamed row's dense cells and ignores its `index`.
