---
"@thomasfosterau/effect-document": minor
"@thomasfosterau/effect-ooxml": minor
---

Ids are now allowed per node (#184). Each node kind that carries attributes has an id facet (`attr.id.header`, `attr.id.link`, …, see `IdFeature` and `ID_FEATURE`). A profile that lists `attr.id` gets all of them, so existing profiles allow ids everywhere as before; a profile can instead list only the nodes its format keeps ids on. `collectFeatures` reports a document's ids as their nodes' facets, and `narrow` keeps an id only where the target allows it there. A dropped id's loss entry now names the node's facet: `attr.id.link`, say, where it used to say `attr.id`.

`narrow` now also narrows the attributes of code blocks and definition lists, and the contents of definition lists and line blocks, which it used to pass through unchanged.

DOCX keeps heading ids: a heading's first bookmark reads as its id (Word's hidden `_GoBack` / `_Toc…` bookmarks only when a link goes to them), and a heading's id is written as a bookmark around it, so a `#id` link lands on it. The DOCX profile adds `attr.id.header` and no other id facet.
