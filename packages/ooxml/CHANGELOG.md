# @thomasfosterau/effect-ooxml

## 0.1.0

### Minor Changes

- [#213](https://github.com/thomasfosterau/effect-document/pull/213) [`8fde077`](https://github.com/thomasfosterau/effect-document/commit/8fde077dc9858e50540b07bec0b578f193ce998a) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - DOCX keeps ids on bookmarked text ([#184](https://github.com/thomasfosterau/effect-document/issues/184)): a bookmark that isn't a heading's id reads as a `Span` with the bookmark's name as its id (an empty bookmark, a place to link to, as an empty span), and a `Span` with an id is written as a bookmark around its runs, so a `#id` link lands on it. The DOCX profile adds `inline.span` and `attr.id.span`. A heading's id is now only a bookmark around the whole heading; one around part of it is a span inside the heading. Word's hidden bookmarks (`_GoBack`, `_Toc…`) are still kept only when a link goes to them. A span without an id says nothing, so its content is written without one.

- [#160](https://github.com/thomasfosterau/effect-document/pull/160) [`bd639a7`](https://github.com/thomasfosterau/effect-document/commit/bd639a7a318d5de3b40f14b5584c45a2d9f6d702) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - Profiles no longer overclaim ([#109](https://github.com/thomasfosterau/effect-document/issues/109)).

  `Format<R, W = R>` now has separate `readProfile` and `writeProfile` fields in place of `profile`. A format's write profile is what its writer preserves through `read(write(doc))`, and `convert` narrows to it, so anything a writer would silently drop or downgrade is now reported in the loss report.

  Trimmed to what round-trips today:

  - **XLSX:** new `Xlsx` (write) and `XlsxRead` profiles replace the full `Spreadsheet` profile. Columns, merges, styles, rich text, attributes and dates are not preserved.
  - **DOCX:** code blocks, block quotes, divs, line blocks, rules, inline code and quotations are not preserved.
  - **PPTX and RTF:** headers are not preserved.
  - **PDF:** new `PdfWrite` profile. Block quotes, rules, line breaks, underline and strikeout are not preserved.

  A new integration test round-trips a sample of every write-profile feature for every format, so profile drift fails CI.

- [#11](https://github.com/thomasfosterau/effect-document/pull/11) [`3d5d706`](https://github.com/thomasfosterau/effect-document/commit/3d5d706b7303027ed0d42e2dfdb5da17ccd2c090) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - Split into a monorepo: a core package plus one package per format family.

  - `@thomasfosterau/effect-document` is now the core only: the schema, the profile system, the Reader/Writer/Format abstractions and `convert`. It no longer re-exports any format, and no longer depends on `fflate` or `@thomasfosterau/effect-parse`. The built-in profiles are also available on the new `./profiles` subpath, and the IO layer on `./io`.
  - `@thomasfosterau/effect-csv`: CSV/TSV (was `./csv`).
  - `@thomasfosterau/effect-ooxml`: `Xlsx`, `Docx` and `Pptx` namespaces, also on the `./xlsx`, `./docx` and `./pptx` subpaths.
  - `@thomasfosterau/effect-rtf`: RTF (was `./rtf`).
  - `@thomasfosterau/effect-iwork`: `Pages`, `Numbers`, `Keynote` and the container `Codec` namespaces, also on the `./pages`, `./numbers`, `./keynote` and `./codec` subpaths (the codec was `./iwork`).

  Migrate imports like so:

  ```ts
  // before
  import { convert, Csv, Xlsx } from "@thomasfosterau/effect-document";
  // after
  import { convert } from "@thomasfosterau/effect-document";
  import * as Csv from "@thomasfosterau/effect-csv";
  import { Xlsx } from "@thomasfosterau/effect-ooxml";
  ```

- [#9](https://github.com/thomasfosterau/effect-document/pull/9) [`6f9eff3`](https://github.com/thomasfosterau/effect-document/commit/6f9eff3a0cf51c8ec1aa9a38f2bcb429b71cb4dc) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - Parse OOXML parts with an `@thomasfosterau/effect-parse` grammar.

  - Malformed XML now fails with a positioned `ParseError` (line, column and what was expected) rather than a bare `Error`. `parseXml` still throws; the new `parseXmlResult` returns a `Result` instead.
  - Closing tags must match their element (`<a><b></a>` is an error, reported at `<b>`), and content after the root element is rejected. A leading byte order mark is accepted.
  - Output is unchanged: all 617 XML parts of python-docx's Word test files parse identically, at the same speed (about 10% faster on a 7.9 MB worksheet).

- [#209](https://github.com/thomasfosterau/effect-document/pull/209) [`1411a17`](https://github.com/thomasfosterau/effect-document/commit/1411a17e1c2c4effd6852cd7207fe8cd7d865e48) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - Ids are now allowed per node ([#184](https://github.com/thomasfosterau/effect-document/issues/184)). Each node kind that carries attributes has an id facet (`attr.id.header`, `attr.id.link`, …, see `IdFeature` and `ID_FEATURE`). A profile that lists `attr.id` gets all of them, so existing profiles allow ids everywhere as before; a profile can instead list only the nodes its format keeps ids on. `collectFeatures` reports a document's ids as their nodes' facets, and `narrow` keeps an id only where the target allows it there. A dropped id's loss entry now names the node's facet: `attr.id.link`, say, where it used to say `attr.id`.

  `narrow` now also narrows the attributes of code blocks and definition lists, and the contents of definition lists and line blocks, which it used to pass through unchanged.

  DOCX keeps heading ids: a heading's first bookmark reads as its id (Word's hidden `_GoBack` / `_Toc…` bookmarks only when a link goes to them), and a heading's id is written as a bookmark around it, so a `#id` link lands on it. The DOCX profile adds `attr.id.header` and no other id facet.

- [#9](https://github.com/thomasfosterau/effect-document/pull/9) [`b8a7a3f`](https://github.com/thomasfosterau/effect-document/commit/b8a7a3f5fa140005574c4a6f7239432ecdb63fe6) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - Move the RTF lexer and A1 references onto `@thomasfosterau/effect-parse`.

  - The RTF reader now lexes with a compiled effect-parse grammar (groups, control words with signed parameters, control symbols, `\'hh` escapes, text) and interprets the tokens. Output is unchanged, and it is about 20% faster.
  - `parseA1` is a parser too, and now rejects row 0 (`"A0"`), which used to produce row -1.
  - New: `parseA1Absolute` for `$`-pinned references (`"$B$3"`) and `parseA1Range` for ranges (`"A1:B2"`). The `a1Cell`, `a1AbsoluteCell` and `a1Range` parsers are exported for use in larger grammars.

- [#199](https://github.com/thomasfosterau/effect-document/pull/199) [`5ffbd4a`](https://github.com/thomasfosterau/effect-document/commit/5ffbd4a99b8b5faa8e152743cf9a1e0dbdb309f9) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - Worksheets are sparse ([#185](https://github.com/thomasfosterau/effect-document/issues/185)). **Breaking:** a `SheetRow` now carries its 0-based `index` and holds `IndexedCell`s (`{ col, cell }`) in strictly ascending column order, and a `Worksheet` holds only the rows it has, in strictly ascending `index` order; decoding (and the constructors) reject rows or cells out of order, repeated or at a negative or fractional position. The JSON form changes accordingly: `{ index, cells: [{ col, cell }] }` per row.

  New in core: `IndexedCell`, `sheetRow` (a sparse row from a dense array of cells), `sheetExtent`, and the derived dense view `denseRows` (rectangular by default, `{ rectangular: false }` for each row up to its own last cell). Because a sparse sheet's extent can be billions of cells, `denseRows` returns a `Result` and builds the grid only within a budget (`maxCells`, default `DEFAULT_MAX_DENSE_CELLS`, five million; `denseSize` gives the cost), failing with `DenseGridTooLarge` before allocating. `worksheet(...)` still takes a dense grid and keeps every cell given. Text collapse (`blocksToText`) of a worksheet is now the cells it holds, tab-separated, one line per held row, without laying out gaps. Narrowing a worksheet to a prose table lays it out by its dense grid, and drops it with a `sheet.worksheet` loss entry when the grid is over budget.

  XLSX: the reader keeps only valued cells at their own row and column, so a sheet with one value at A1 and one at XFD1048576 holds two cells instead of failing or allocating its extent. `<dimension>` is no longer read, and `maxCells` now bounds the valued cells summed over the workbook (it was rows × columns of the dense grids). Trailing blank rows and columns, and blank cells generally, are no longer recovered on read. The writer writes each row and cell at its own index.

  CSV: the reader keeps every field (blanks included) as before, now as rows `0..n` with cells `0..m`. The writer writes a gap between cells as an empty field and a row the sheet does not hold as an empty line, within a new `maxFields` budget (default `DEFAULT_MAX_FIELDS`, five million, counting one per line): a sheet whose gaps expand past it fails with a `WriteError` before rendering. `renderCsvStream` writes each streamed row from column 0 to its last cell, ignores its `index`, and fails on a row wider than `maxFields`.

- [#6](https://github.com/thomasfosterau/effect-document/pull/6) [`407bca5`](https://github.com/thomasfosterau/effect-document/commit/407bca5d098ab1dee14da5e5317aacfa2ec271d6) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - Add DOCX (Word), PPTX (PowerPoint) and RTF formats, each with its own profile.

  - **DOCX** (WordprocessingML): reads/writes headings, runs (bold/italic/ underline/strike/super/sub/small-caps), hyperlinks, bullet/ordered lists and tables.
  - **PPTX** (PresentationML): reads/writes a structurally valid deck of slides whose text-box / placeholder shapes hold paragraphs, headings and lists.
  - **RTF**: reads/writes paragraphs and headings with bold/italic/underline/ strike runs.

  Each format defines its own subset profile (`Docx`, `Pptx`, `Rtf`), so they exercise the conversion machinery across document families: `Rtf → Docx` widens for free, while `Docx → Rtf` and `Pptx → Docx`/`Rtf` narrow with a loss report (links to text, lists to paragraphs, slides flattened to prose, tables dropped).

  Internally, the OOXML XML parser and a new OPC packaging helper are shared across xlsx/docx/pptx in the shared OOXML module. The XLSX reader now also round-trips formula cells.

### Patch Changes

- [#150](https://github.com/thomasfosterau/effect-document/pull/150) [`6d725f0`](https://github.com/thomasfosterau/effect-document/commit/6d725f09bfcff05196c598540e3945f3d671f94d) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - Deeply nested documents no longer overflow the stack in feature collection (`Profile.is`, `validate`, `collectFeatures`) or in the text collapse (`blocksToText`, `inlinesToText`, `cellToText`, `shapeToText`): these walks now use an explicit stack.

  New in core: `nestingDepth` / `blocksNestingDepth` (iterative), `DEFAULT_MAX_NESTING_DEPTH` (128, below the depth at which Schema encoding of nested tables overflows the stack), `limitNestingDepth`, and an optional `ParseError.code` (`"LimitExceeded"`). The DOCX and PDF readers, whose nesting follows the input, take a `maxDepth` option and fail with a `LimitExceeded` ParseError past it.

- [#156](https://github.com/thomasfosterau/effect-document/pull/156) [`58fd4d6`](https://github.com/thomasfosterau/effect-document/commit/58fd4d630e88260cdc2d9ccc87ce2c3fc7d8c922) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - DOCX correctness fixes.

  Writer:

  - Hyperlink targets are attribute-escaped.
  - Each ordered list gets its own numbering instance, honouring `start`.
  - Nested lists and other blocks inside list items are kept.
  - `Quoted` gets its quotation marks.
  - `\n` and `\t` become `w:br` and `w:tab`.
  - A `styles.xml` part defines Heading1–6, Code and TableGrid.
  - `#anchor` links are written as internal hyperlinks.

  Reader:

  - ST_OnOff "off" values and `w:u="none"` are honoured.
  - `numId="0"` is not a list item.
  - List kinds, nesting and start numbers come from `numbering.xml` and `w:ilvl`.
  - Text in tracked insertions and content controls is kept, and deleted text is dropped.
  - Simple and complex `HYPERLINK` fields become links.
  - `w:anchor` becomes `#anchor`.
  - A page break ends the paragraph.
  - Code-styled paragraphs read back as code blocks.

- [#204](https://github.com/thomasfosterau/effect-document/pull/204) [`87d1d85`](https://github.com/thomasfosterau/effect-document/commit/87d1d852ce7a60c747d86f5211023583b34e5376) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - DOCX: a list item's blocks after its first paragraph (further paragraphs, code blocks, headings, tables) now stay in the item. The writer indents them to the item's level, as Word indents a list's continuation paragraphs, and the reader attaches a paragraph or table indented to an open list's level (from `numbering.xml`, `w:ind` `w:left` or `w:start`) to that list's last item. An item that starts with a code block, table or nested list reads back without the empty numbered paragraph the writer has to put before it.

- [#178](https://github.com/thomasfosterau/effect-document/pull/178) [`182d0ea`](https://github.com/thomasfosterau/effect-document/commit/182d0ea632110ffb1faf857020790c8171fe50f1) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - Depend on `@thomasfosterau/effect-parse` `^0.2.0` (was `^0.1.0`), whose `Parser.compile` is now `Compiler.jit`.

  - `scanCsvStream` (and so the CSV reader's `readStream`) runs a compiled row grammar, memoized per dialect and options like the whole-text one: about twice as fast on a 4 MB file. Rows and errors are unchanged.
  - The `a1AbsoluteCell` and `a1Range` parsers (`parseA1Absolute`, `parseA1Range`) are compiled too, like `a1Cell`.

- [#158](https://github.com/thomasfosterau/effect-document/pull/158) [`bd411b4`](https://github.com/thomasfosterau/effect-document/commit/bd411b412a811ab6fd3bed100fe112506ffc5e49) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - Harden the OOXML XML parser and OPC package handling.

  XML parser:

  - It now builds its tree iteratively, so 20,000+ levels of nesting no longer overflow the stack.
  - `parseXmlResult` never throws, and invalid character references become U+FFFD.
  - Element namespaces are resolved into a new `ns` field. When `w:val` and `w14:val` both exist, `getAttr` prefers the attribute in the element's own namespace.
  - `mc:AlternateContent` resolves to an understood `mc:Choice`, otherwise to the `mc:Fallback`.
  - DOCTYPE internal subsets are skipped, and entities are never expanded.
  - Names are validated, and duplicate attributes are rejected.

  `OpcReader`:

  - Parts are inflated lazily, within configurable limits on entry count, per-part size and total size (`OpcLimits`, the reader option `limits`).
  - Part names match case-insensitively, and relationship targets are percent-decoded.
  - UTF-16 parts are decoded.
  - `[Content_Types].xml` is checked, so a package of the wrong type fails with `WrongPackageType` instead of reading as empty.

  Readers:

  - Malformed XML reports its part and line/column in `ParseError.position`.
  - The XLSX reader uses the shared `OpcReader`.

  Writers:

  - Zip output is byte-deterministic (fixed `mtime`).

- [#205](https://github.com/thomasfosterau/effect-document/pull/205) [`6910111`](https://github.com/thomasfosterau/effect-document/commit/69101112e13ba14ab5b28dafee9a84b843286f98) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - PPTX: a list item's later paragraphs now stay in the item, and adjacent ordered lists stay separate. The writer puts an item's bulleted paragraph at its level's margin (`marL`, with a hanging `indent`) and the item's later paragraphs at the same margin without a bullet, as PowerPoint does; the reader attaches an unbulleted paragraph at an open list's margin to that list's last item. Each ordered list's first item carries `startAt`, so the reader begins a new list there, and an ordered list's `start` round-trips. An item that starts with a nested list reads back without the empty bulleted paragraph the writer has to put before it.

- [#153](https://github.com/thomasfosterau/effect-document/pull/153) [`7ddb4dd`](https://github.com/thomasfosterau/effect-document/commit/7ddb4dd8c14fbbebd65de7219565c5a2e127ed91) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - PPTX reader:

  - Shapes inside group shapes (`p:grpSp`) are now read.
  - `b="true"` and `i="true"` are recognised.
  - A `<p:ph>` without a type defaults to `obj`.
  - Title placeholders read as level-1 headers.
  - Field text (`a:fld`) is kept.
  - Paragraph `lvl` nests bullet lists.
  - A slide with a missing relationship or part fails the read instead of being skipped.

  PPTX writer:

  - Nested lists are written with `lvl`.
  - Headers in title placeholders are written without bold, so they round-trip.

- [#194](https://github.com/thomasfosterau/effect-document/pull/194) [`ee78713`](https://github.com/thomasfosterau/effect-document/commit/ee78713d16674a818c999bd9f764c71c700fbced) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - Write profiles are now checked by a property test, and writers render their profiles exhaustively ([#109](https://github.com/thomasfosterau/effect-document/issues/109)).

  - New in the core: `TagsOf<F>` (the node tags a feature set names) and `InlineOf<F>`, `BlockOf<F>`, `CellOf<F>` and `ShapeOf<F>` (the nodes a `Doc<F>` may hold), plus the `isNodeIn(profile, node)` guard. The DOCX, PPTX, PDF and RTF writers render through tables exhaustive over these, so adding a feature to a profile without a writer for it is a compile error.
  - **PDF:** inline code leaves the `PdfWrite` profile: a monospace run that fills a line reads back as a code block, so converting to PDF now reports inline code as a loss.
  - **DOCX:** hyperlinks take their look from a `Hyperlink` character style instead of a direct underline, so they no longer read back wrapped in `Underline`; every list gets its own numbering instance, so adjacent lists stay separate; a heading that leads a list item keeps its heading style and reads back as a `Header`.
  - **TSV:** a line of tabs is a row of empty fields rather than a blank line, so the reader no longer drops it.
  - **RTF:** a node outside the RTF profile, in a document handed to the writer with `trustAs`, is dropped instead of throwing.

- [#165](https://github.com/thomasfosterau/effect-document/pull/165) [`286249e`](https://github.com/thomasfosterau/effect-document/commit/286249e7b9f794d79d0475f8a63cbee48d621d08) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - Publish built ESM and declarations: every entry point's `exports` now resolves to `dist/` (one bundle per subpath, `sideEffects: false`) instead of the TypeScript sources, and the `effect` peer range is `>=4.0.0-rc.118`.

  Errors are Schema tagged errors throughout. The core's `ParseError`, `WriteError`, `ProfileViolation` and `ConversionError` keep their tags and fields. In `@thomasfosterau/effect-pdf/cos`, `PdfSyntaxError` and `PdfFilterError` are tagged errors constructed from an options object (`new PdfSyntaxError({ reason, offset })`, `new PdfFilterError({ filter, reason })`) with the same `message` text, and `rewritePdf` refuses an encrypted file with the new `PdfEncryptedError`. `@thomasfosterau/effect-iwork/codec`'s `IworkError` keeps its tag, fields and `message`, and its reasons are also exported as the `IworkErrorReason` schema. The OOXML readers report a missing part as an `OpcError` of the new kind `"MissingPart"` (the `ParseError`'s `cause`) instead of a bare `Error`, and the XLSX writer's failure for a document without worksheets now reads `document contains no worksheets to write`.

  Fixes: an RTF control word named like an `Object.prototype` member (`\constructor`) no longer injects that member's text. Additions: `ComponentPathOrder` (component paths in natural order, as an `Order`; `compareComponentPaths` now returns an `Ordering`), the `ResolvedLimits` type behind `DEFAULT_BUNDLE_LIMITS`, the named `VarintRead` that `readVarint` returns, and a doc comment on every export.

- [#145](https://github.com/thomasfosterau/effect-document/pull/145) [`c66a018`](https://github.com/thomasfosterau/effect-document/commit/c66a018e445017ad45ee81364a19886822254cac) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - XLSX reader: size each worksheet's grid by the cells that hold a value, so empty `<row>`s and style-only cells no longer extend it, and fail with a `ParseError` when the extent would exceed the new `maxCells` option (default 5,000,000) instead of allocating the grid. `<dimension>` is honoured as a hint within that limit, and the writer now declares it to preserve trailing blank rows and columns.

- [#146](https://github.com/thomasfosterau/effect-document/pull/146) [`100acfa`](https://github.com/thomasfosterau/effect-document/commit/100acfae3433a450665fbdb10bb55be0af79f5df) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - XLSX reader fixes:

  - Chartsheets, dialogsheets and macrosheets no longer fail the read. They come back as empty worksheets tagged `attr.data.kind`.
  - Rows and cells without an `r` attribute follow the previous row or cell instead of being placed by ordinal.
  - The dependent cells of a shared formula get the master formula translated by their offset, instead of an empty formula.
  - Phonetic guide text (`<rPh>`) is no longer concatenated into strings.
  - `_xHHHH_` escapes are decoded.
  - ISO 8601 `t="d"` cells read as `CellDate`.

- [#186](https://github.com/thomasfosterau/effect-document/pull/186) [`ac6c095`](https://github.com/thomasfosterau/effect-document/commit/ac6c0956a05b65022ef1308c5f32cca592df7b9b) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - XLSX reader: `maxCells` now bounds the cells of the whole workbook rather than each worksheet, so a small file with many sheets (or many `<sheet>` entries pointing at one worksheet part, each widened by its `<dimension>` hint) can no longer allocate sheets × `maxCells` blank cells. A sheet whose extent exceeds what the sheets before it left fails with a `ParseError`, and a `<dimension>` hint that would exceed it is ignored.

- [#161](https://github.com/thomasfosterau/effect-document/pull/161) [`990f266`](https://github.com/thomasfosterau/effect-document/commit/990f26694047949c7846c6292f0b4a0edc878721) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - The XLSX writer now uses the shared OOXML namespace constants and `zipParts` instead of its own copies.

- [#147](https://github.com/thomasfosterau/effect-document/pull/147) [`56a9bf4`](https://github.com/thomasfosterau/effect-document/commit/56a9bf43c36838d0b24264122125ae4b7e306b42) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - XLSX writer: emit files Excel opens without repair.

  - `NaN` and `±Infinity` are written as `#NUM!` error cells.
  - Characters that are invalid in XML 1.0 are `_xHHHH_`-encoded, and a literal `_xHHHH_` is escaped with `_x005F_`.
  - Sheet names are sanitised deterministically: invalid characters, empty names, `History`, more than 31 characters, and case-insensitive duplicates. See `sanitizeSheetNames`.
  - A leading `=` is stripped from formulas. `CellFormula.formula` is documented as never including it.
  - `<calcPr fullCalcOnLoad="1"/>` is emitted when a formula has no cached result.
  - `sst@count` is now the reference count, with `uniqueCount` as the distinct count.
  - `docProps/core.xml` and `docProps/app.xml` are written.

- [#190](https://github.com/thomasfosterau/effect-document/pull/190) [`802034b`](https://github.com/thomasfosterau/effect-document/commit/802034b7d43b7d18f2ce905ed1ef5e4ea808a554) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - Align the zip-bomb limits of the OOXML and iWork readers, so both are configured and fail the same way:

  - OOXML: `OpcLimits` takes iWork's names, `maxEntrySize` (was `maxPartBytes`) and `maxTotalSize` (was `maxTotalBytes`), and every limit is optional (`?: number | undefined`; an explicit `undefined` keeps the default). The defaults are now iWork's: 10,000 entries, 256 MiB per part (was 100 MiB) and 512 MiB in total (was 500 MiB). The reader option is `limits?: OpcLimits` (was `Partial<OpcLimits>`).
  - iWork: `ResolvedLimits` is renamed `ResolvedBundleLimits`, to match OOXML's new `ResolvedOpcLimits`. A limit failure becomes a `ParseError` with `code: "LimitExceeded"`, as OOXML's does, and every reader `ParseError`'s `reason` now names the `IworkError` reason (`Failed to read keynote: Truncated: …`).
  - Both report a limit with the same messages: `more than N zip entries`, `<entry> is N bytes uncompressed, over the M-byte limit` and `the parts read exceed the N-byte total limit`.

- Updated dependencies [[`6d725f0`](https://github.com/thomasfosterau/effect-document/commit/6d725f09bfcff05196c598540e3945f3d671f94d), [`574c067`](https://github.com/thomasfosterau/effect-document/commit/574c067407cd2cf4473258f13c4ae3fdf7820f75), [`bd639a7`](https://github.com/thomasfosterau/effect-document/commit/bd639a7a318d5de3b40f14b5584c45a2d9f6d702), [`cb5fe2c`](https://github.com/thomasfosterau/effect-document/commit/cb5fe2ca0e443fc7911424d728f8f5560d920de2), [`3d5d706`](https://github.com/thomasfosterau/effect-document/commit/3d5d706b7303027ed0d42e2dfdb5da17ccd2c090), [`1411a17`](https://github.com/thomasfosterau/effect-document/commit/1411a17e1c2c4effd6852cd7207fe8cd7d865e48), [`87fc1a7`](https://github.com/thomasfosterau/effect-document/commit/87fc1a7ccde3cfc3bcfe43404fbdfe1b1695b940), [`ee78713`](https://github.com/thomasfosterau/effect-document/commit/ee78713d16674a818c999bd9f764c71c700fbced), [`5ffbd4a`](https://github.com/thomasfosterau/effect-document/commit/5ffbd4a99b8b5faa8e152743cf9a1e0dbdb309f9), [`666dff0`](https://github.com/thomasfosterau/effect-document/commit/666dff09a95e5ae8454965d573644e609f0fe5f2), [`3fe668f`](https://github.com/thomasfosterau/effect-document/commit/3fe668f4cbc81a126b298718f77a3c18437a4f54), [`286249e`](https://github.com/thomasfosterau/effect-document/commit/286249e7b9f794d79d0475f8a63cbee48d621d08), [`56a9bf4`](https://github.com/thomasfosterau/effect-document/commit/56a9bf43c36838d0b24264122125ae4b7e306b42)]:
  - @thomasfosterau/effect-document@0.2.0
