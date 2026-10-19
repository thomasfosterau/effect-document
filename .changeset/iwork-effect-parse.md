---
"@thomasfosterau/effect-document-iwork": patch
---

Read iWork Protobuf fields and `.iwa` chunk headers with
`@thomasfosterau/effect-parse`.

- Truncated fields are now errors. A fixed-width or length-delimited field
  that ran past the end of its message used to yield `NaN` or silently
  shortened bytes. `parseMessage`, `readVarint` and `dechunk` now throw a
  positioned `ParseError` (e.g. "length-delimited field needs 5 bytes, only 1
  left" at its offset).
- New `varint`, `field` and `message` parsers are exported for use in larger
  byte grammars.
- Output is unchanged on the fixtures: all 119 `.iwa` streams dechunk
  identically, and all 1,271 top-level payloads parse identically. Reading is
  within about 15% of the previous speed.
