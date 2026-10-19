---
"@thomasfosterau/effect-iwork": minor
---

Add experimental, read-only Apple iWork support (Pages / Numbers / Keynote) plus
a dependency-free container codec.

iWork '13+ files are reverse-engineered binary bundles - a zip of `.iwa`
components holding Protobuf messages wrapped in a non-standard Snappy variant.
This adds `@thomasfosterau/effect-iwork`: a from-scratch, dependency-free
codec for the whole container stack (the Snappy *block* format, IWA chunk
framing, a generic schema-free Protobuf wire reader, the archived-object stream,
and the zip-bundle opener), verified byte-for-byte against real Apple files.

On top of it, read-only readers extract text:
- **Keynote** (`.key`): slide text -> a presentation document (validated against a
  real Apple `.key` fixture).
- **Pages** (`.pages`): body text -> a prose document (best-effort; no public
  Pages fixtures exist to validate against).
- **Numbers** (`.numbers`): sheet structure (names -> empty worksheets); cell
  values are deferred (Numbers stores them in a hand-packed binary blob).

Password-protected documents are detected (top-level `.iwph`) and refused.
Writing iWork files requires the proprietary, version-specific object-graph
schemas and is a future phase. The readers are experimental and version-sensitive.
