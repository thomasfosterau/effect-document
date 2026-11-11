---
"@thomasfosterau/effect-document": minor
---

Profiles take two more kinds of structural rule (#126). `onlyWithin` allows a feature only inside a given node, optionally one whose field holds one of a set of values. `fieldValues` restricts the values a node's own field may hold. `is` / `validate` reject a document that breaks one, and `narrow` converts the node as if the profile lacked the feature there, with the rule's reason in the loss entry. `Profile` gains `onlyWithin` and `fieldValues` (both empty unless given).

The PPTX write profile now includes `block.header`, at level 1 and in a title placeholder only (#196). The writer writes such a header as the slide's title, and the reader reads it back as one, so converting a deck with slide titles to PPTX is lossless. A header anywhere else narrows to a paragraph, and the loss report says why. `PptxRead` is now the same profile as `Pptx`. `TITLE_PLACEHOLDER_TYPES` is exported.
