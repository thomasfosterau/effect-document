---
"@thomasfosterau/effect-iwork": patch
---

iWork reader fixes:

- A zip with no `Index/*.iwa` components fails with a typed reason instead of reading as an empty document. A `.docx` or another zip gives `NotIwork`, and an iWork '09 package (`index.apxl`, `index.xml`, or their `.gz` forms) gives `LegacyIwork09Unsupported`.
- Keynote slide components are ordered by their numeric id (`Slide-8060` before `Slide-10000`), not lexicographically. Suffixed components (`Slide-NNNN-2.iwa`) are now read as slides too. `componentPaths` uses the new `compareComponentPaths` natural sort.
- Numbers sheets follow the order of `TN.DocumentArchive.sheets` instead of zip entry order.
