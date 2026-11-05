---
"@thomasfosterau/effect-document": minor
"@thomasfosterau/effect-csv": minor
"@thomasfosterau/effect-ooxml": minor
---

Plain rows (#227): a worksheet's `rows` may hold a row's cells alone, a `PlainRow`, standing for the unstyled `SheetRow` one past the row before it (row 0 when first) with no height. It is a bare array in JSON (`{ "rows": [[1, "a"], [2, "b"]] }`), and the stack-safe codec reads and writes it. `Worksheet.rows` widens to `ReadonlyArray<SheetRow | PlainRow>`: read rows through the new `rowsOf` (nodes, a plain row's built on demand), `rowIndexes` and `rowCellsOf` (no nodes), or `isPlainRow`; `rowEntries` and `cellAt` accept either form. `worksheetFromRows` accepts plain rows, with an optional `numberRows` hint (positions of rows of plain numbers, checked without boxing them). The CSV reader's documents now hold plain rows, so a read builds no node per row (`read` of a 100k-row table of 17-digit floats: 1.21x to about 1.05x uDSV's `typedArrs` with schema inference). The XLSX reader writes a row that follows on from the one before as a plain row.
