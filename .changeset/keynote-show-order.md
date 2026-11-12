---
"@thomasfosterau/effect-document": patch
---

fix(iwork): the Keynote reader orders slides by the show's slide tree (`KN.ShowArchive` → slide nodes, nested slides after their parent) through the object resolver, not by component id (#99). A package without a slide tree keeps the component order.
