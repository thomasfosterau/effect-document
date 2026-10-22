---
"@thomasfosterau/effect-ooxml": patch
---

XLSX reader: size each worksheet's grid by the cells that hold a value, so empty `<row>`s and style-only cells no longer extend it, and fail with a `ParseError` when the extent would exceed the new `maxCells` option (default 5,000,000) instead of allocating the grid. `<dimension>` is honoured as a hint within that limit, and the writer now declares it to preserve trailing blank rows and columns.
