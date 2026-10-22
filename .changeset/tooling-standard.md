---
"@thomasfosterau/effect-document": patch
"@thomasfosterau/effect-csv": patch
"@thomasfosterau/effect-iwork": patch
"@thomasfosterau/effect-ooxml": patch
"@thomasfosterau/effect-pdf": patch
"@thomasfosterau/effect-rtf": patch
---

Publish built ESM and declarations: every entry point's `exports` now resolves to `dist/` (one bundle per subpath, `sideEffects: false`) instead of the TypeScript sources, and the `effect` peer range is `>=4.0.0-rc.118`.

Errors are Schema tagged errors throughout. The core's `ParseError`, `WriteError`, `ProfileViolation` and `ConversionError` keep their tags and fields. In `@thomasfosterau/effect-pdf/cos`, `PdfSyntaxError` and `PdfFilterError` are tagged errors constructed from an options object (`new PdfSyntaxError({ reason, offset })`, `new PdfFilterError({ filter, reason })`) with the same `message` text, and `rewritePdf` refuses an encrypted file with the new `PdfEncryptedError`. `@thomasfosterau/effect-iwork/codec` throws the new `IworkFormatError` (an encrypted bundle, a malformed varint), and the OOXML readers report a missing main part through the new `MissingPartError` as the `ParseError`'s `cause`.

`readVarint` returns the named `VarintRead`, the iWork registry's type-id sets are `HashSet`s, and every export has a doc comment.
