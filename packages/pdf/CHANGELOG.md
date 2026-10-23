# @thomasfosterau/effect-pdf

## 0.1.0

### Minor Changes

- [#160](https://github.com/thomasfosterau/effect-document/pull/160) [`bd639a7`](https://github.com/thomasfosterau/effect-document/commit/bd639a7a318d5de3b40f14b5584c45a2d9f6d702) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - Profiles no longer overclaim ([#109](https://github.com/thomasfosterau/effect-document/issues/109)).

  `Format<R, W = R>` now has separate `readProfile` and `writeProfile` fields in place of `profile`. A format's write profile is what its writer preserves through `read(write(doc))`, and `convert` narrows to it, so anything a writer would silently drop or downgrade is now reported in the loss report.

  Trimmed to what round-trips today:

  - **XLSX:** new `Xlsx` (write) and `XlsxRead` profiles replace the full `Spreadsheet` profile. Columns, merges, styles, rich text, attributes and dates are not preserved.
  - **DOCX:** code blocks, block quotes, divs, line blocks, rules, inline code and quotations are not preserved.
  - **PPTX and RTF:** headers are not preserved.
  - **PDF:** new `PdfWrite` profile. Block quotes, rules, line breaks, underline and strikeout are not preserved.

  A new integration test round-trips a sample of every write-profile feature for every format, so profile drift fails CI.

- [#12](https://github.com/thomasfosterau/effect-document/pull/12) [`a812c0c`](https://github.com/thomasfosterau/effect-document/commit/a812c0cb517d3ce90042e04000aeb8219d3b9013) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - Add `@thomasfosterau/effect-pdf`: a PDF reader and writer with its own profile (`Pdf`), built on a dependency-light PDF object layer.

  - **Reading** extracts each page's positioned text (simple and Type 0 fonts, `/ToUnicode` CMaps, standard encodings and `/Differences`, `/ActualText`, Form XObjects, rotated pages) and infers prose from the layout: headings ranked by font size, paragraphs (joined across page breaks), bullet/ordered/ nested lists, code blocks, bold, italic, inline code, and links from link annotations. The document information dictionary becomes the metadata. Encrypted files are refused.
  - **Writing** typesets headings, word-wrapped paragraphs, nested lists, code blocks, block quotes, rules, bold/italic/underline/strikeout, inline code and clickable links onto A4/Letter/custom pages with the standard 14 fonts (WinAnsi characters only).
  - **`@thomasfosterau/effect-pdf/cos`**, the object layer: the object model, a lenient parser, stream filters (Flate with predictors, LZW, ASCIIHex, ASCII85, RunLength), `PdfFile` for opening files (xref tables and streams, object streams, incremental updates, and repair of damaged files), content-stream tokenizing, and `PdfBuilder` / `rewritePdf` for writing.

- [#172](https://github.com/thomasfosterau/effect-document/pull/172) [`21ce6b3`](https://github.com/thomasfosterau/effect-document/commit/21ce6b304f7af1a2c978dab529ab9424ce0d822f) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - Scanned pages: the reader lists pages that paint images but have no text in the document's `pagesWithoutText` metadata, and OCRs them when given an engine. The new `ocr` reader option (or the `OcrEngine` service with `PdfOcrReaderLive`) takes any engine implementing `OcrEngineShape`; none is bundled. The engine receives each image as the file stores it: JPEG, JPEG 2000, CCITT and JBIG2 data are passed through encoded, and other images arrive as decoded gray, RGB or CMYK samples. The words it returns are laid out like any other text. `PageText` gains `images`, and `decodeFilters` now also returns the image codec's `imageParms`.

- [#194](https://github.com/thomasfosterau/effect-document/pull/194) [`ee78713`](https://github.com/thomasfosterau/effect-document/commit/ee78713d16674a818c999bd9f764c71c700fbced) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - Write profiles are now checked by a property test, and writers render their profiles exhaustively ([#109](https://github.com/thomasfosterau/effect-document/issues/109)).

  - New in the core: `TagsOf<F>` (the node tags a feature set names) and `InlineOf<F>`, `BlockOf<F>`, `CellOf<F>` and `ShapeOf<F>` (the nodes a `Doc<F>` may hold), plus the `isNodeIn(profile, node)` guard. The DOCX, PPTX, PDF and RTF writers render through tables exhaustive over these, so adding a feature to a profile without a writer for it is a compile error.
  - **PDF:** inline code leaves the `PdfWrite` profile: a monospace run that fills a line reads back as a code block, so converting to PDF now reports inline code as a loss.
  - **DOCX:** hyperlinks take their look from a `Hyperlink` character style instead of a direct underline, so they no longer read back wrapped in `Underline`; every list gets its own numbering instance, so adjacent lists stay separate; a heading that leads a list item keeps its heading style and reads back as a `Header`.
  - **TSV:** a line of tabs is a row of empty fields rather than a blank line, so the reader no longer drops it.
  - **RTF:** a node outside the RTF profile, in a document handed to the writer with `trustAs`, is dropped instead of throwing.

### Patch Changes

- [#150](https://github.com/thomasfosterau/effect-document/pull/150) [`6d725f0`](https://github.com/thomasfosterau/effect-document/commit/6d725f09bfcff05196c598540e3945f3d671f94d) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - Deeply nested documents no longer overflow the stack in feature collection (`Profile.is`, `validate`, `collectFeatures`) or in the text collapse (`blocksToText`, `inlinesToText`, `cellToText`, `shapeToText`): these walks now use an explicit stack.

  New in core: `nestingDepth` / `blocksNestingDepth` (iterative), `DEFAULT_MAX_NESTING_DEPTH` (128, below the depth at which Schema encoding of nested tables overflows the stack), `limitNestingDepth`, and an optional `ParseError.code` (`"LimitExceeded"`). The DOCX and PDF readers, whose nesting follows the input, take a `maxDepth` option and fail with a `LimitExceeded` ParseError past it.

- [#192](https://github.com/thomasfosterau/effect-document/pull/192) [`a7a5c5c`](https://github.com/thomasfosterau/effect-document/commit/a7a5c5cba25f75195f26b4ac4258410636222b67) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - The COS parser refuses arrays and dictionaries nested more than `MAX_OBJECT_NESTING` (512) levels deep with a `PdfSyntaxError` carrying `code: "LimitExceeded"`, instead of overflowing the stack; the reader reports it as a `ParseError` with the same code.

- [#162](https://github.com/thomasfosterau/effect-document/pull/162) [`58ae24f`](https://github.com/thomasfosterau/effect-document/commit/58ae24f1266ffe21db23ce2e35d9aab05d528b61) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - PDF reader: one-line paragraphs are no longer merged into one paragraph. The paragraph-break threshold now comes from the line spacing inside paragraphs, so the gaps between paragraphs no longer distort it. Double-spaced text is still read as continuous paragraphs.

- [#165](https://github.com/thomasfosterau/effect-document/pull/165) [`286249e`](https://github.com/thomasfosterau/effect-document/commit/286249e7b9f794d79d0475f8a63cbee48d621d08) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - Publish built ESM and declarations: every entry point's `exports` now resolves to `dist/` (one bundle per subpath, `sideEffects: false`) instead of the TypeScript sources, and the `effect` peer range is `>=4.0.0-rc.118`.

  Errors are Schema tagged errors throughout. The core's `ParseError`, `WriteError`, `ProfileViolation` and `ConversionError` keep their tags and fields. In `@thomasfosterau/effect-pdf/cos`, `PdfSyntaxError` and `PdfFilterError` are tagged errors constructed from an options object (`new PdfSyntaxError({ reason, offset })`, `new PdfFilterError({ filter, reason })`) with the same `message` text, and `rewritePdf` refuses an encrypted file with the new `PdfEncryptedError`. `@thomasfosterau/effect-iwork/codec`'s `IworkError` keeps its tag, fields and `message`, and its reasons are also exported as the `IworkErrorReason` schema. The OOXML readers report a missing part as an `OpcError` of the new kind `"MissingPart"` (the `ParseError`'s `cause`) instead of a bare `Error`, and the XLSX writer's failure for a document without worksheets now reads `document contains no worksheets to write`.

  Fixes: an RTF control word named like an `Object.prototype` member (`\constructor`) no longer injects that member's text. Additions: `ComponentPathOrder` (component paths in natural order, as an `Order`; `compareComponentPaths` now returns an `Ordering`), the `ResolvedLimits` type behind `DEFAULT_BUNDLE_LIMITS`, the named `VarintRead` that `readVarint` returns, and a doc comment on every export.

- Updated dependencies [[`6d725f0`](https://github.com/thomasfosterau/effect-document/commit/6d725f09bfcff05196c598540e3945f3d671f94d), [`574c067`](https://github.com/thomasfosterau/effect-document/commit/574c067407cd2cf4473258f13c4ae3fdf7820f75), [`bd639a7`](https://github.com/thomasfosterau/effect-document/commit/bd639a7a318d5de3b40f14b5584c45a2d9f6d702), [`3d5d706`](https://github.com/thomasfosterau/effect-document/commit/3d5d706b7303027ed0d42e2dfdb5da17ccd2c090), [`87fc1a7`](https://github.com/thomasfosterau/effect-document/commit/87fc1a7ccde3cfc3bcfe43404fbdfe1b1695b940), [`ee78713`](https://github.com/thomasfosterau/effect-document/commit/ee78713d16674a818c999bd9f764c71c700fbced), [`5ffbd4a`](https://github.com/thomasfosterau/effect-document/commit/5ffbd4a99b8b5faa8e152743cf9a1e0dbdb309f9), [`286249e`](https://github.com/thomasfosterau/effect-document/commit/286249e7b9f794d79d0475f8a63cbee48d621d08), [`56a9bf4`](https://github.com/thomasfosterau/effect-document/commit/56a9bf43c36838d0b24264122125ae4b7e306b42)]:
  - @thomasfosterau/effect-document@0.2.0
