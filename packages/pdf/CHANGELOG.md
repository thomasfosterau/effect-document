# @thomasfosterau/effect-pdf

## 0.1.0

### Minor Changes

- bd639a7: Profiles no longer overclaim (#109).

  `Format<R, W = R>` now has separate `readProfile` and `writeProfile` fields in place of `profile`. A format's write profile is what its writer preserves through `read(write(doc))`, and `convert` narrows to it, so anything a writer would silently drop or downgrade is now reported in the loss report.

  Trimmed to what round-trips today:

  - **XLSX:** new `Xlsx` (write) and `XlsxRead` profiles replace the full `Spreadsheet` profile. Columns, merges, styles, rich text, attributes and dates are not preserved.
  - **DOCX:** code blocks, block quotes, divs, line blocks, rules, inline code and quotations are not preserved.
  - **PPTX and RTF:** headers are not preserved.
  - **PDF:** new `PdfWrite` profile. Block quotes, rules, line breaks, underline and strikeout are not preserved.

  A new integration test round-trips a sample of every write-profile feature for every format, so profile drift fails CI.

- a812c0c: Add `@thomasfosterau/effect-pdf`: a PDF reader and writer with its own profile
  (`Pdf`), built on a dependency-light PDF object layer.

  - **Reading** extracts each page's positioned text (simple and Type 0 fonts,
    `/ToUnicode` CMaps, standard encodings and `/Differences`, `/ActualText`,
    Form XObjects, rotated pages) and infers prose from the layout: headings
    ranked by font size, paragraphs (joined across page breaks), bullet/ordered/
    nested lists, code blocks, bold, italic, inline code, and links from link
    annotations. The document information dictionary becomes the metadata.
    Encrypted files are refused.
  - **Writing** typesets headings, word-wrapped paragraphs, nested lists, code
    blocks, block quotes, rules, bold/italic/underline/strikeout, inline code
    and clickable links onto A4/Letter/custom pages with the standard 14 fonts
    (WinAnsi characters only).
  - **`@thomasfosterau/effect-pdf/cos`**, the object layer: the object model, a
    lenient parser, stream filters (Flate with predictors, LZW, ASCIIHex,
    ASCII85, RunLength), `PdfFile` for opening files (xref tables and streams,
    object streams, incremental updates, and repair of damaged files),
    content-stream tokenizing, and `PdfBuilder` / `rewritePdf` for writing.

### Patch Changes

- 6d725f0: Deeply nested documents no longer overflow the stack in feature collection
  (`Profile.is`, `validate`, `collectFeatures`) or in the text collapse
  (`blocksToText`, `inlinesToText`, `cellToText`, `shapeToText`): these walks
  now use an explicit stack.

  New in core: `nestingDepth` / `blocksNestingDepth` (iterative),
  `DEFAULT_MAX_NESTING_DEPTH` (1000), `limitNestingDepth`, and an optional
  `ParseError.code` (`"LimitExceeded"`). The DOCX and PDF readers, whose
  nesting follows the input, take a `maxDepth` option and fail with a
  `LimitExceeded` ParseError past it.

- 58ae24f: PDF reader: one-line paragraphs are no longer merged into one paragraph. The paragraph-break threshold now comes from the line spacing inside paragraphs, so the gaps between paragraphs no longer distort it. Double-spaced text is still read as continuous paragraphs.
- Updated dependencies [6d725f0]
- Updated dependencies [574c067]
- Updated dependencies [bd639a7]
- Updated dependencies [3d5d706]
- Updated dependencies [87fc1a7]
- Updated dependencies [56a9bf4]
  - @thomasfosterau/effect-document@0.2.0
