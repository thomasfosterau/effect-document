---
"@thomasfosterau/effect-document": patch
"@thomasfosterau/effect-csv": patch
---

`cell.number` builds its node with a constructor function, as `cell.text` does: 40 bytes rather than 56. The CSV reader builds the cells of a column of mostly unique numbers from the number read in place in the text, without making its string first. Together they make `read` of a table of unique numbers about a third faster, and its document about a ninth smaller.
