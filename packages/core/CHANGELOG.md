# @thomasfosterau/effect-document

## 0.2.0

### Minor Changes

- [#150](https://github.com/thomasfosterau/effect-document/pull/150) [`6d725f0`](https://github.com/thomasfosterau/effect-document/commit/6d725f09bfcff05196c598540e3945f3d671f94d) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - Deeply nested documents no longer overflow the stack in feature collection (`Profile.is`, `validate`, `collectFeatures`) or in the text collapse (`blocksToText`, `inlinesToText`, `cellToText`, `shapeToText`): these walks now use an explicit stack.

  New in core: `nestingDepth` / `blocksNestingDepth` (iterative), `DEFAULT_MAX_NESTING_DEPTH` (128, below the depth at which Schema encoding of nested tables overflows the stack), `limitNestingDepth`, and an optional `ParseError.code` (`"LimitExceeded"`). The DOCX and PDF readers, whose nesting follows the input, take a `maxDepth` option and fail with a `LimitExceeded` ParseError past it.

- [#9](https://github.com/thomasfosterau/effect-document/pull/9) [`574c067`](https://github.com/thomasfosterau/effect-document/commit/574c067407cd2cf4473258f13c4ae3fdf7820f75) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - Migrate to Effect 4. The `effect` peer dependency is now `^4.0.0`.

  - Node schemas use the Effect 4 Schema API (`Schema.Union([...])`, `Schema.Literals([...])`, `Schema.Record(key, value)`, `Schema.Codec`). Encode and decode with `Schema.encodeEffect` / `Schema.decodeEffect`.
  - `CellDate` still encodes to an ISO-8601 string (`Schema.DateFromString`).
  - `Profile.schema` is typed as `Schema.Codec<Doc<F>, DocumentEncoded>`.
  - `makeReaderTag` / `makeWriterTag` return `Context.Service` keys.

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

- [#209](https://github.com/thomasfosterau/effect-document/pull/209) [`1411a17`](https://github.com/thomasfosterau/effect-document/commit/1411a17e1c2c4effd6852cd7207fe8cd7d865e48) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - Ids are now allowed per node ([#184](https://github.com/thomasfosterau/effect-document/issues/184)). Each node kind that carries attributes has an id facet (`attr.id.header`, `attr.id.link`, …, see `IdFeature` and `ID_FEATURE`). A profile that lists `attr.id` gets all of them, so existing profiles allow ids everywhere as before; a profile can instead list only the nodes its format keeps ids on. `collectFeatures` reports a document's ids as their nodes' facets, and `narrow` keeps an id only where the target allows it there. A dropped id's loss entry now names the node's facet: `attr.id.link`, say, where it used to say `attr.id`.

  `narrow` now also narrows the attributes of code blocks and definition lists, and the contents of definition lists and line blocks, which it used to pass through unchanged.

  DOCX keeps heading ids: a heading's first bookmark reads as its id (Word's hidden `_GoBack` / `_Toc…` bookmarks only when a link goes to them), and a heading's id is written as a bookmark around it, so a `#id` link lands on it. The DOCX profile adds `attr.id.header` and no other id facet.

- [#6](https://github.com/thomasfosterau/effect-document/pull/6) [`87fc1a7`](https://github.com/thomasfosterau/effect-document/commit/87fc1a7ccde3cfc3bcfe43404fbdfe1b1695b940) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - Replace the two-layer IR (Document AST + tabular Workbook + legacy effect-csv shim) with a single, type-safe **profile-based universal document schema**.

  - **One schema** spanning prose, spreadsheets (a `Worksheet` block of typed cells), and presentations (a `SlideShow` block) — a Pandoc-superset with a structured + open attribute model.
  - **Profiles** are named subsets of the schema. Documents are phantom-typed `Doc<F>` so "subset of" is ordinary TypeScript assignability: readers return exactly their format's subset, and writers reject (at compile time) any document too rich to represent.
  - **`narrow`/`widen`** transform documents between subsets — widening is free, narrowing is lossy and reports exactly what was dropped or down-converted. **`convert`** widens or narrows automatically and returns a loss report.
  - CSV and XLSX are retrofitted onto the new schema (`Csv`/`Xlsx` profiles).

  Breaking: the old `Workbook`/`Sheet`/`Cell` IR, the `convert()` return shape (now `{ content, loss }`), and the `/legacy` entry point are removed. New subpath entry points `/schema` and `/profile` are added.

- [#194](https://github.com/thomasfosterau/effect-document/pull/194) [`ee78713`](https://github.com/thomasfosterau/effect-document/commit/ee78713d16674a818c999bd9f764c71c700fbced) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - Write profiles are now checked by a property test, and writers render their profiles exhaustively ([#109](https://github.com/thomasfosterau/effect-document/issues/109)).

  - New in the core: `TagsOf<F>` (the node tags a feature set names) and `InlineOf<F>`, `BlockOf<F>`, `CellOf<F>` and `ShapeOf<F>` (the nodes a `Doc<F>` may hold), plus the `isNodeIn(profile, node)` guard. The DOCX, PPTX, PDF and RTF writers render through tables exhaustive over these, so adding a feature to a profile without a writer for it is a compile error.
  - **PDF:** inline code leaves the `PdfWrite` profile: a monospace run that fills a line reads back as a code block, so converting to PDF now reports inline code as a loss.
  - **DOCX:** hyperlinks take their look from a `Hyperlink` character style instead of a direct underline, so they no longer read back wrapped in `Underline`; every list gets its own numbering instance, so adjacent lists stay separate; a heading that leads a list item keeps its heading style and reads back as a `Header`.
  - **TSV:** a line of tabs is a row of empty fields rather than a blank line, so the reader no longer drops it.
  - **RTF:** a node outside the RTF profile, in a document handed to the writer with `trustAs`, is dropped instead of throwing.

- [#199](https://github.com/thomasfosterau/effect-document/pull/199) [`5ffbd4a`](https://github.com/thomasfosterau/effect-document/commit/5ffbd4a99b8b5faa8e152743cf9a1e0dbdb309f9) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - Worksheets are sparse ([#185](https://github.com/thomasfosterau/effect-document/issues/185)). **Breaking:** a `SheetRow` now carries its 0-based `index` and holds `IndexedCell`s (`{ col, cell }`) in strictly ascending column order, and a `Worksheet` holds only the rows it has, in strictly ascending `index` order; decoding (and the constructors) reject rows or cells out of order, repeated or at a negative or fractional position. The JSON form changes accordingly: `{ index, cells: [{ col, cell }] }` per row.

  New in core: `IndexedCell`, `sheetRow` (a sparse row from a dense array of cells), `sheetExtent`, and the derived dense view `denseRows` (rectangular by default, `{ rectangular: false }` for each row up to its own last cell). Because a sparse sheet's extent can be billions of cells, `denseRows` returns a `Result` and builds the grid only within a budget (`maxCells`, default `DEFAULT_MAX_DENSE_CELLS`, five million; `denseSize` gives the cost), failing with `DenseGridTooLarge` before allocating. `worksheet(...)` still takes a dense grid and keeps every cell given. Text collapse (`blocksToText`) of a worksheet is now the cells it holds, tab-separated, one line per held row, without laying out gaps. Narrowing a worksheet to a prose table lays it out by its dense grid, and drops it with a `sheet.worksheet` loss entry when the grid is over budget.

  XLSX: the reader keeps only valued cells at their own row and column, so a sheet with one value at A1 and one at XFD1048576 holds two cells instead of failing or allocating its extent. `<dimension>` is no longer read, and `maxCells` now bounds the valued cells summed over the workbook (it was rows × columns of the dense grids). Trailing blank rows and columns, and blank cells generally, are no longer recovered on read. The writer writes each row and cell at its own index.

  CSV: the reader keeps every field (blanks included) as before, now as rows `0..n` with cells `0..m`. The writer writes a gap between cells as an empty field and a row the sheet does not hold as an empty line, within a new `maxFields` budget (default `DEFAULT_MAX_FIELDS`, five million, counting one per line): a sheet whose gaps expand past it fails with a `WriteError` before rendering. `renderCsvStream` writes each streamed row from column 0 to its last cell, ignores its `index`, and fails on a row wider than `maxFields`.

- [#208](https://github.com/thomasfosterau/effect-document/pull/208) [`666dff0`](https://github.com/thomasfosterau/effect-document/commit/666dff09a95e5ae8454965d573644e609f0fe5f2) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - Add `encodeDocument` / `decodeDocument` (and `encodeDocumentResult` / `decodeDocumentResult`), a wire codec for `Document` that handles any nesting depth ([#191](https://github.com/thomasfosterau/effect-document/issues/191)). Effect's Schema parser recurses once per level, so encoding or decoding a document a few hundred levels deep with `Schema` overflows the call stack and dies with a defect; the new codec walks the tree with an explicit work list. It produces the same JSON (key order included) and the same documents as the Schema codec, and fails with a `SchemaError` pointing at the offending node.

- [#206](https://github.com/thomasfosterau/effect-document/pull/206) [`3fe668f`](https://github.com/thomasfosterau/effect-document/commit/3fe668f4cbc81a126b298718f77a3c18437a4f54) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - Profiles can carry structural rules: `defineProfile(id, features, { notWithin })` keeps a feature the profile allows out of a given node. `is` and `validate` reject a document that breaks a rule, and `narrow` (so `convert`) rewrites the inner node as if the profile lacked the feature there, with a loss entry giving the rule's reason. `Profile` gains a `notWithin` field, and `collectFeaturesWithin` reports the features used inside nodes of a given feature.

  RTF and PDF set headings in bold, so their write profiles (`Rtf`, `PdfWrite`) now keep `Strong` out of `Header`: converting a heading with bold text to RTF or PDF unwraps the bold and reports the loss, where it used to report the conversion as lossless ([#197](https://github.com/thomasfosterau/effect-document/issues/197)).

### Patch Changes

- [#215](https://github.com/thomasfosterau/effect-document/pull/215) [`cb5fe2c`](https://github.com/thomasfosterau/effect-document/commit/cb5fe2ca0e443fc7911424d728f8f5560d920de2) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - Tidy declarations flagged by type-aware linting, with no change in behaviour: `sheetRow`'s optional `height` parameter is declared `height?: number`, and `narrowEffect`, `synthesizeTable` and `synthesizeDocument` spell their never-failing return type `Effect<A>` instead of `Effect<A, never>`.

- [#165](https://github.com/thomasfosterau/effect-document/pull/165) [`286249e`](https://github.com/thomasfosterau/effect-document/commit/286249e7b9f794d79d0475f8a63cbee48d621d08) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - Publish built ESM and declarations: every entry point's `exports` now resolves to `dist/` (one bundle per subpath, `sideEffects: false`) instead of the TypeScript sources, and the `effect` peer range is `>=4.0.0-rc.118`.

  Errors are Schema tagged errors throughout. The core's `ParseError`, `WriteError`, `ProfileViolation` and `ConversionError` keep their tags and fields. In `@thomasfosterau/effect-pdf/cos`, `PdfSyntaxError` and `PdfFilterError` are tagged errors constructed from an options object (`new PdfSyntaxError({ reason, offset })`, `new PdfFilterError({ filter, reason })`) with the same `message` text, and `rewritePdf` refuses an encrypted file with the new `PdfEncryptedError`. `@thomasfosterau/effect-iwork/codec`'s `IworkError` keeps its tag, fields and `message`, and its reasons are also exported as the `IworkErrorReason` schema. The OOXML readers report a missing part as an `OpcError` of the new kind `"MissingPart"` (the `ParseError`'s `cause`) instead of a bare `Error`, and the XLSX writer's failure for a document without worksheets now reads `document contains no worksheets to write`.

  Fixes: an RTF control word named like an `Object.prototype` member (`\constructor`) no longer injects that member's text. Additions: `ComponentPathOrder` (component paths in natural order, as an `Order`; `compareComponentPaths` now returns an `Ordering`), the `ResolvedLimits` type behind `DEFAULT_BUNDLE_LIMITS`, the named `VarintRead` that `readVarint` returns, and a doc comment on every export.

- [#147](https://github.com/thomasfosterau/effect-document/pull/147) [`56a9bf4`](https://github.com/thomasfosterau/effect-document/commit/56a9bf43c36838d0b24264122125ae4b7e306b42) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - XLSX writer: emit files Excel opens without repair.

  - `NaN` and `±Infinity` are written as `#NUM!` error cells.
  - Characters that are invalid in XML 1.0 are `_xHHHH_`-encoded, and a literal `_xHHHH_` is escaped with `_x005F_`.
  - Sheet names are sanitised deterministically: invalid characters, empty names, `History`, more than 31 characters, and case-insensitive duplicates. See `sanitizeSheetNames`.
  - A leading `=` is stripped from formulas. `CellFormula.formula` is documented as never including it.
  - `<calcPr fullCalcOnLoad="1"/>` is emitted when a formula has no cached result.
  - `sst@count` is now the reference count, with `uniqueCount` as the distinct count.
  - `docProps/core.xml` and `docProps/app.xml` are written.
