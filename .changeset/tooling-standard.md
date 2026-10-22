---
"@thomasfosterau/effect-document": patch
"@thomasfosterau/effect-csv": patch
"@thomasfosterau/effect-iwork": patch
"@thomasfosterau/effect-ooxml": patch
"@thomasfosterau/effect-pdf": patch
"@thomasfosterau/effect-rtf": patch
---

Publish built ESM and declarations: every entry point's `exports` now resolves to `dist/` (one bundle per subpath, `sideEffects: false`) instead of the TypeScript sources, and the `effect` peer range is `>=4.0.0-rc.118`.

Errors are Schema tagged errors throughout. The core's `ParseError`, `WriteError`, `ProfileViolation` and `ConversionError` keep their tags and fields. In `@thomasfosterau/effect-pdf/cos`, `PdfSyntaxError` and `PdfFilterError` are tagged errors constructed from an options object (`new PdfSyntaxError({ reason, offset })`, `new PdfFilterError({ filter, reason })`) with the same `message` text, and `rewritePdf` refuses an encrypted file with the new `PdfEncryptedError`. `@thomasfosterau/effect-iwork/codec`'s `IworkError` keeps its tag, fields and `message`, and its reasons are also exported as the `IworkErrorReason` schema. The OOXML readers report a missing part as an `OpcError` of the new kind `"MissingPart"` (the `ParseError`'s `cause`) instead of a bare `Error`, and the XLSX writer's failure for a document without worksheets now reads `document contains no worksheets to write`.

Fixes: an RTF control word named like an `Object.prototype` member (`\constructor`) no longer injects that member's text. Additions: `ComponentPathOrder` (component paths in natural order, as an `Order`; `compareComponentPaths` now returns an `Ordering`), the `ResolvedLimits` type behind `DEFAULT_BUNDLE_LIMITS`, the named `VarintRead` that `readVarint` returns, and a doc comment on every export.
