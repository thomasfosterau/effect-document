---
"@thomasfosterau/effect-pdf": minor
---

The PDF writer writes a document outline (bookmarks) from the headings, nested by level, each item going to the top of its heading (#20, #198). The layout reader, for an untagged file, takes a heading's level from the outline item with its text (its depth), and ranks the rest by size as before.
