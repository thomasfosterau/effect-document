---
"@thomasfosterau/effect-document": minor
---

The PPTX reader resolves master, layout and presentation inheritance (#82): a paragraph's bullet, numbering start, left margin and bold / italic / underline / strike now come from the shape's list style, the matching layout and master placeholders, the master's text styles and the presentation's defaults, so the bullet lists of real decks are read (they were lost). A slide's `layout` is its layout's name, under the new read-only `deck.layout` feature (`PptxRead`; `narrow` to `Pptx` drops it and reports it). A slide with no layout, or a layout with no master, reads as before and reports a `pptx.layoutMissing` / `pptx.masterMissing` diagnostic.
