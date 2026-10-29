---
"@thomasfosterau/effect-document": minor
"@thomasfosterau/effect-rtf": patch
"@thomasfosterau/effect-pdf": patch
---

Profiles can carry structural rules: `defineProfile(id, features, { notWithin })` keeps a feature the profile allows out of a given node. `is` and `validate` reject a document that breaks a rule, and `narrow` (so `convert`) rewrites the inner node as if the profile lacked the feature there, with a loss entry giving the rule's reason. `Profile` gains a `notWithin` field, and `collectFeaturesWithin` reports the features used inside nodes of a given feature.

RTF and PDF set headings in bold, so their write profiles (`Rtf`, `PdfWrite`) now keep `Strong` out of `Header`: converting a heading with bold text to RTF or PDF unwraps the bold and reports the loss, where it used to report the conversion as lossless (#197).
