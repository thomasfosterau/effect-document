---
"@thomasfosterau/effect-ooxml": minor
---

Parse OOXML parts with an `@thomasfosterau/effect-parse` grammar.

- Malformed XML now fails with a positioned `ParseError` (line, column and what was expected) rather than a bare `Error`. `parseXml` still throws; the new `parseXmlResult` returns a `Result` instead.
- Closing tags must match their element (`<a><b></a>` is an error, reported at `<b>`), and content after the root element is rejected. A leading byte order mark is accepted.
- Output is unchanged: all 617 XML parts of python-docx's Word test files parse identically, at the same speed (about 10% faster on a 7.9 MB worksheet).
