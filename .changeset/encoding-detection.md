---
"@thomasfosterau/effect-document": minor
---

A new `./encoding` subpath detects and decodes the text encoding of bytes whose encoding isn't known (#188): `detectEncoding` returns the encoding (from a byte-order mark, UTF-16's zero bytes, valid UTF-8, or the Windows-1252 fallback) with a confidence and evidence, and `decodeText` decodes strictly with that encoding or one the caller picks, failing with a `ParseError` (`MalformedText`, at its byte offset) rather than replacing a byte. It is built on `@thomasfosterau/effect-ext`'s `/Encoding`, a new dependency that only this subpath loads.
