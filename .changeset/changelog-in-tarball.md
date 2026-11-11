---
"@thomasfosterau/effect-document": patch
---

Ship `CHANGELOG.md` in the published tarball, so the release notes can be read from `node_modules` (#251). `table()` and `rewritePdf` no longer overflow the stack on more than about 100k rows or objects, and the PDF text layout, CMap and OCR line code no longer spread a whole list into `Math.min` (#225). `new SheetRow` and `new Worksheet` now reject an object that isn't a cell node, where they used to turn `{ col: 0 }` into a blank cell (#228).
