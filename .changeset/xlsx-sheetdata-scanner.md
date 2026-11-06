---
"@thomasfosterau/effect-document": patch
---

The XLSX reader reads a worksheet's `sheetData` straight into rows, with no element tree, when it holds the plain markup writers emit (`<row>`s of `<c>`s with a `<v>` or a plain inline string). Anything else (a formula, rich text, a comment, unusual markup, a sheet over `maxCells`) is read as before, so documents and errors are unchanged. Reading a 20,000 × 8 sheet takes about a third less time.
