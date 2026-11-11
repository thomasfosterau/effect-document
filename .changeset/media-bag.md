---
"@thomasfosterau/effect-document": minor
---

feat: a media bag for binary resources (#113). `Document.resources` holds `Resource`s (bytes, media type, file name; base64 in JSON) that nodes refer to by `resource:<id>` URLs, deduplicated by content through `withResource` / `addResource`. The new `doc.resources` feature is in `Html`, `Presentation` and `Full`, and `narrow` reports every resource it drops. `imageInfo` reads a PNG, JPEG, GIF or SVG's size and resolution from its header, and `emuExtent` sizes it for DOCX and PPTX.
