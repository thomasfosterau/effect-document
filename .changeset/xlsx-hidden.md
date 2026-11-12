---
"@thomasfosterau/effect-document": minor
---

Hidden rows, columns and worksheets. The schema gains `SheetRow.hidden`, `SheetColumn.hidden` and `Worksheet.visibility` (`"hidden"` or `"veryHidden"`), all under the new `sheet.hidden` feature; `narrow` shows them for a profile without it and reports each kind as a loss. `withSheetLayout` takes an optional visibility. XLSX reads and writes `hidden="1"` on rows and columns and `<sheet state>`, opens a workbook whose first sheet is hidden on its first shown one, and refuses to write a workbook with every sheet hidden.
