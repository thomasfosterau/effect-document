---
"@thomasfosterau/effect-document": minor
---

feat: `narrow` degrades instead of dropping (#111). A `Worksheet` or `Table` sent to a target with neither tables nor worksheets becomes one paragraph per row, its cells tab-separated: CSV → RTF used to give an empty document. A `HorizontalRule` becomes a `***` paragraph, and an `Image` keeps its URL after its alt text. Each is reported as `converted`, not `dropped`.
