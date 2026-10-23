---
"@thomasfosterau/effect-document": minor
"@thomasfosterau/effect-pdf": minor
"@thomasfosterau/effect-ooxml": patch
"@thomasfosterau/effect-csv": patch
"@thomasfosterau/effect-rtf": patch
---

Write profiles are now checked by a property test, and writers render their profiles exhaustively (#109).

- New in the core: `TagsOf<F>` (the node tags a feature set names) and `InlineOf<F>`, `BlockOf<F>`, `CellOf<F>` and `ShapeOf<F>` (the nodes a `Doc<F>` may hold), plus the `isNodeIn(profile, node)` guard. The DOCX, PPTX, PDF and RTF writers render through tables exhaustive over these, so adding a feature to a profile without a writer for it is a compile error.
- **PDF:** inline code leaves the `PdfWrite` profile: a monospace run that fills a line reads back as a code block, so converting to PDF now reports inline code as a loss.
- **DOCX:** hyperlinks take their look from a `Hyperlink` character style instead of a direct underline, so they no longer read back wrapped in `Underline`; every list gets its own numbering instance, so adjacent lists stay separate; a heading that leads a list item keeps its heading style and reads back as a `Header`.
- **TSV:** a line of tabs is a row of empty fields rather than a blank line, so the reader no longer drops it.
- **RTF:** a node outside the RTF profile, in a document handed to the writer with `trustAs`, is dropped instead of throwing.
