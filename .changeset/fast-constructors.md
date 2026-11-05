---
"@thomasfosterau/effect-document": minor
---

Building documents is several times faster. `cell.text` / `number` / `boolean` / `blank`, `str`, `sheetRow` and `worksheet` no longer run the `Schema.Class` constructor's schema pass when their input is already valid; they build the same node directly (an instance of its class, `Equal.equals` to the one `new` builds, with the same keys). Invalid input still fails as before. Text cells and indexed cells are built by constructor functions sized to their fields (40 bytes a node rather than 56), and `cell.boolean` / `cell.blank` return one shared instance per value, since nodes are immutable. `cellToText` reads a cell's value directly, without the general text collapse. New: `sparseRow(index, [[col, cell], …], height?)`, the same fast constructor for rows whose cells skip columns, which fails as `new SheetRow` does on columns out of order.

`narrow` keeps the worksheets, rows and cells it leaves unchanged instead of rebuilding them (nodes are immutable), so `convert` from a spreadsheet to a format that can hold its cells copies nothing.
