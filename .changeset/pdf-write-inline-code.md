---
"@thomasfosterau/effect-document": minor
---

`PdfWrite` allows inline code again (#212). The writer tags its output and the reader takes blocks from the tags, so a `Code` inline stays inside its paragraph through `read(write(doc))`; `convert` to PDF no longer narrows inline code away with a loss entry.
