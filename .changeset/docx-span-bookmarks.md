---
"@thomasfosterau/effect-ooxml": minor
---

DOCX keeps ids on bookmarked text (#184): a bookmark that isn't a heading's id reads as a `Span` with the bookmark's name as its id (an empty bookmark, a place to link to, as an empty span), and a `Span` with an id is written as a bookmark around its runs, so a `#id` link lands on it. The DOCX profile adds `inline.span` and `attr.id.span`. A heading's id is now only a bookmark around the whole heading; one around part of it is a span inside the heading. Word's hidden bookmarks (`_GoBack`, `_Toc…`) are still kept only when a link goes to them. A span without an id says nothing, so its content is written without one.
