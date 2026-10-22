---
"@thomasfosterau/effect-ooxml": patch
---

PPTX reader:

- Shapes inside group shapes (`p:grpSp`) are now read.
- `b="true"` and `i="true"` are recognised.
- A `<p:ph>` without a type defaults to `obj`.
- Title placeholders read as level-1 headers.
- Field text (`a:fld`) is kept.
- Paragraph `lvl` nests bullet lists.
- A slide with a missing relationship or part fails the read instead of being skipped.

PPTX writer:

- Nested lists are written with `lvl`.
- Headers in title placeholders are written without bold, so they round-trip.
