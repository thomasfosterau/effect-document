---
"@thomasfosterau/effect-document": minor
---

XLSX reads and writes cell hyperlinks: a linked cell is a `CellRichText` whose one run is a `Link` (a URL, or a place in the workbook as `#Sheet!A1`, with its tooltip as the target's `title`). A link on a cell that holds no text is dropped with an `xlsx.hyperlinkDropped` diagnostic. Profiles gain a fourth structural rule, `whole` (`Whole`, `breaksWhole`): a feature that must be the whole of a container's content, which `is`, `validate` and `narrow` enforce. The XLSX profiles keep a `Link` to a rich cell's only run with it, `narrow` widening a link over part of a cell over all of it, and the writer refuses a cell that breaks it.
