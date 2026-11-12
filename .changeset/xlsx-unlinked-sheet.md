---
"@thomasfosterau/effect-document": patch
---

fix(xlsx): a sheet the workbook lists with no relationship id (a leftover VBA module, Apache POI bug 60825) now reads as an empty worksheet tagged `kind: "unlinked"`, instead of failing the whole workbook (#173).
