# @thomasfosterau/effect-csv

## 0.1.0

### Minor Changes

- [#167](https://github.com/thomasfosterau/effect-document/pull/167) [`925f0d2`](https://github.com/thomasfosterau/effect-document/commit/925f0d2720f35aab16225baaf9aa59a7a474d739) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - New reader defaults, by owner decision on [#88](https://github.com/thomasfosterau/effect-document/issues/88):

  - The CSV reader sniffs the header row when `treatFirstRowAsHeader` is unset. The first row is the header when it has at least two rows, every value in the first row is non-empty text, and at least one column below it is all numbers or booleans (like Python's `csv.Sniffer.has_header`). An explicit `true` or `false` overrides the sniff. The header row is read as text and left out of inference. The scanners and `readStream` still default to no header.
  - Type inference is per-column by default (`inference` defaults to `"column"`): a column is numeric or boolean only if every value in it is, and otherwise the whole column stays text. Pass `inference: "cell"` for the previous value-by-value inference.

- [#9](https://github.com/thomasfosterau/effect-document/pull/9) [`c6badbd`](https://github.com/thomasfosterau/effect-document/commit/c6badbdff77ba6b5f695d4fc1a5ca11ca39082dc) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - Rewrite the CSV scanner on `@thomasfosterau/effect-parse`.

  - Quoted fields may now contain line breaks (RFC 4180), so fields the CSV writer quotes for embedded newlines read back intact.
  - Bare CR line endings are accepted (previously a bare `\r` inside a line hung the scanner).
  - An unclosed quote is a `ParseError` with its row and column, instead of being silently closed at the end of the line.
  - New `scanCsvStream(chunks, dialect, options)` scans a `Stream` of text chunks and emits each row as soon as it is complete. `readStream` uses it, so rows are no longer all scanned up front.
  - `scanCsv` uses a compiled, cached grammar: about 14x faster on a 4.5 MB file.

- [#166](https://github.com/thomasfosterau/effect-document/pull/166) [`bfeeb6f`](https://github.com/thomasfosterau/effect-document/commit/bfeeb6f0c06d1de45348c98e28cf42c7acd4c9ce) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - Add a `validateHeaders` scan option. When set, a header row with an empty or whitespace-only name, or a name used twice, fails with a `ParseError` that gives the column. This applies to the first row and to `providedHeaders`, in both `scanCsv` and `scanCsvStream`. It is off by default, so such headers are still kept as they are.

- [#187](https://github.com/thomasfosterau/effect-document/pull/187) [`daabfef`](https://github.com/thomasfosterau/effect-document/commit/daabfef78c438cd6da16b8b37548b75c9b55638e) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - Add an `escapeChar` writer option ([#89](https://github.com/thomasfosterau/effect-document/issues/89)), as Python's `escapechar` with `doublequote=False`: a wrapper inside a quoted field is written after the escape character instead of being doubled. It fails closed: a field holding the escape character itself fails the write, and `quoting: "none"` still fails on a field that needs quotes rather than escaping its separators or line breaks. An `escapeChar` that is not one character, or that is the separator, the wrapper or a line break, fails the write (or the stream). `formatNumber` now accepts an explicit `undefined`. The README documents the writer options and the formula-injection risk `escapeFormulae` guards against.

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

- [#199](https://github.com/thomasfosterau/effect-document/pull/199) [`5ffbd4a`](https://github.com/thomasfosterau/effect-document/commit/5ffbd4a99b8b5faa8e152743cf9a1e0dbdb309f9) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - Worksheets are sparse ([#185](https://github.com/thomasfosterau/effect-document/issues/185)). **Breaking:** a `SheetRow` now carries its 0-based `index` and holds `IndexedCell`s (`{ col, cell }`) in strictly ascending column order, and a `Worksheet` holds only the rows it has, in strictly ascending `index` order; decoding (and the constructors) reject rows or cells out of order, repeated or at a negative or fractional position. The JSON form changes accordingly: `{ index, cells: [{ col, cell }] }` per row.

  New in core: `IndexedCell`, `sheetRow` (a sparse row from a dense array of cells), `sheetExtent`, and the derived dense view `denseRows` (rectangular by default, `{ rectangular: false }` for each row up to its own last cell). Because a sparse sheet's extent can be billions of cells, `denseRows` returns a `Result` and builds the grid only within a budget (`maxCells`, default `DEFAULT_MAX_DENSE_CELLS`, five million; `denseSize` gives the cost), failing with `DenseGridTooLarge` before allocating. `worksheet(...)` still takes a dense grid and keeps every cell given. Text collapse (`blocksToText`) of a worksheet is now the cells it holds, tab-separated, one line per held row, without laying out gaps. Narrowing a worksheet to a prose table lays it out by its dense grid, and drops it with a `sheet.worksheet` loss entry when the grid is over budget.

  XLSX: the reader keeps only valued cells at their own row and column, so a sheet with one value at A1 and one at XFD1048576 holds two cells instead of failing or allocating its extent. `<dimension>` is no longer read, and `maxCells` now bounds the valued cells summed over the workbook (it was rows × columns of the dense grids). Trailing blank rows and columns, and blank cells generally, are no longer recovered on read. The writer writes each row and cell at its own index.

  CSV: the reader keeps every field (blanks included) as before, now as rows `0..n` with cells `0..m`. The writer writes a gap between cells as an empty field and a row the sheet does not hold as an empty line, within a new `maxFields` budget (default `DEFAULT_MAX_FIELDS`, five million, counting one per line): a sheet whose gaps expand past it fails with a `WriteError` before rendering. `renderCsvStream` writes each streamed row from column 0 to its last cell, ignores its `index`, and fails on a row wider than `maxFields`.

### Patch Changes

- [`387e496`](https://github.com/thomasfosterau/effect-document/commit/387e496bdb4d0cdaa3a33a48cc31f70375e9d57c) Thanks [@claude](https://github.com/claude)! - Document that `formatCsvNumber` writes `NaN`, `Infinity` and `-Infinity` as text, as pandas does, and that they read back as text.

- [#167](https://github.com/thomasfosterau/effect-document/pull/167) [`12ce2cb`](https://github.com/thomasfosterau/effect-document/commit/12ce2cb5f1dd819c45d72ceb9c25ae2fa654f4b1) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - CSV type inference keeps a value as a number exactly when a double holds its written significant digits, replacing the 15-significant-digit cutoff. Full-precision doubles such as `0.30000000000000004` are now read as numbers. Values that would change when parsed still stay text, such as 20-digit IDs, `9007199254740993` (2^53 + 1) and `1e400`.

- [#179](https://github.com/thomasfosterau/effect-document/pull/179) [`da6b6a4`](https://github.com/thomasfosterau/effect-document/commit/da6b6a48916b3f417dfe1daf29d3860301df95b9) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - `scanCsv` (and so the CSV reader) no longer takes time quadratic in the input when it validates column counts, the default: a record's source row, which is found by walking the text up to it, is now computed only when that record's width is wrong and the error reports it. A 0.25 MB file that took about 3 s now scans in milliseconds.

- [#149](https://github.com/thomasfosterau/effect-document/pull/149) [`a69c912`](https://github.com/thomasfosterau/effect-document/commit/a69c912a31cca75c2c20bd7aa83f8530efa81d79) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - Fix several CSV scanner bugs.

  - A wrapper inside an unquoted field is now a literal character, so `12" pizza,3` no longer swallows the following records. Text after a closing quote is still kept (`"a"b` reads as `ab`). The old behaviour, where quoted segments may start anywhere in a field, is available as `quoteAnywhere`.
  - An empty `wrapper` turns quoting off instead of breaking the parser.
  - Multi-character separators are matched whole, so fields may contain their characters (`a|b||c` with separator `||`).
  - `skipRows` counts CRLF, LF and bare CR line endings, in `scanCsv` and `scanCsvStream` (a CRLF may be split across chunks).
  - `trimWhitespace` keeps whitespace inside quoted fields.
  - Without headers, every row must be as wide as the first unless `allowVariableColumns` is set. Column-count and syntax errors both report the 0-based source row in `position.row`, counting skipped, blank, comment and quoted lines.
  - Stream syntax errors now carry a source position, and an unclosed quote reads "Unclosed quoted field: expected a closing quote" in both scanners.
  - With `treatFirstRowAsHeader`, `providedHeaders` now replace the header row instead of being ignored.
  - The compiled-parser cache evicts the least recently used grammar instead of clearing itself.
  - A leading byte order mark is ignored for text input.

- [#154](https://github.com/thomasfosterau/effect-document/pull/154) [`f9eb32e`](https://github.com/thomasfosterau/effect-document/commit/f9eb32ec33602c6cce03ad6a0349c6e0e4ec7c95) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - Stop CSV type inference from corrupting values, and make it configurable.

  - Only plain decimals (`-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?`) with at most 15 significant digits are read as numbers. `007`, ZIP codes, `0x1F`, `0b11`, `+1`, `12`, `Infinity` and long IDs now stay text.
  - Booleans are matched case-insensitively, so Excel's `TRUE`/`FALSE` read as booleans.
  - New inference options: `inference: "column"` types a whole column by all of its values (per-cell stays the default); `booleans` and `booleansCaseSensitive`; `decimalChar` and `groupChar` (CSVW names); `percent`; and `nullValues` for values read as blank cells.
  - `inferCell` takes the same options as an optional second argument.
  - The `inferTypes` docs describe what inference loses.

- [#151](https://github.com/thomasfosterau/effect-document/pull/151) [`f2d1020`](https://github.com/thomasfosterau/effect-document/commit/f2d1020203f1e7a016a31b94384ac56d5d8bf62c) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - Fix CSV writer data loss and add output options.

  - A row holding a single blank cell is written as `""` instead of an empty line, which the reader dropped.
  - Number cells are written as their shortest round-trip decimal, never in exponent form (`1e21` is written as `1000000000000000000000`). Override with `formatNumber`; `formatCsvNumber` is the default.
  - Fields with leading or trailing whitespace are quoted, and so are fields starting with the new `lineCommentMarker` option, so they read back intact.
  - New `escapeFormulae` option guards against CSV (formula) injection: text starting with `=`, `+`, `-`, `@`, a tab or a CR is prefixed with `'` and quoted. Off by default.
  - New `quoting` option: `minimal` (the default), `all`, `nonNumeric` or `none`. With `none`, writing fails with a `WriteError` if a field can't be read back without quotes.
  - New `bom`, `headers` and `padRows` options.
  - New `renderCsvStream` renders a `Stream` of `SheetRow`s to a `Stream` of CSV text, one chunk per row.
  - The line break is documented as the dialect's `linebreak` (LF by default). The new `Rfc4180Dialect` writes CRLF.

- [#178](https://github.com/thomasfosterau/effect-document/pull/178) [`182d0ea`](https://github.com/thomasfosterau/effect-document/commit/182d0ea632110ffb1faf857020790c8171fe50f1) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - Depend on `@thomasfosterau/effect-parse` `^0.2.0` (was `^0.1.0`), whose `Parser.compile` is now `Compiler.jit`.

  - `scanCsvStream` (and so the CSV reader's `readStream`) runs a compiled row grammar, memoized per dialect and options like the whole-text one: about twice as fast on a 4 MB file. Rows and errors are unchanged.
  - The `a1AbsoluteCell` and `a1Range` parsers (`parseA1Absolute`, `parseA1Range`) are compiled too, like `a1Cell`.

- [#160](https://github.com/thomasfosterau/effect-document/pull/160) [`bd639a7`](https://github.com/thomasfosterau/effect-document/commit/bd639a7a318d5de3b40f14b5584c45a2d9f6d702) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - Profiles no longer overclaim ([#109](https://github.com/thomasfosterau/effect-document/issues/109)).

  `Format<R, W = R>` now has separate `readProfile` and `writeProfile` fields in place of `profile`. A format's write profile is what its writer preserves through `read(write(doc))`, and `convert` narrows to it, so anything a writer would silently drop or downgrade is now reported in the loss report.

  Trimmed to what round-trips today:

  - **XLSX:** new `Xlsx` (write) and `XlsxRead` profiles replace the full `Spreadsheet` profile. Columns, merges, styles, rich text, attributes and dates are not preserved.
  - **DOCX:** code blocks, block quotes, divs, line blocks, rules, inline code and quotations are not preserved.
  - **PPTX and RTF:** headers are not preserved.
  - **PDF:** new `PdfWrite` profile. Block quotes, rules, line breaks, underline and strikeout are not preserved.

  A new integration test round-trips a sample of every write-profile feature for every format, so profile drift fails CI.

- [#215](https://github.com/thomasfosterau/effect-document/pull/215) [`cb5fe2c`](https://github.com/thomasfosterau/effect-document/commit/cb5fe2ca0e443fc7911424d728f8f5560d920de2) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - Tidy declarations flagged by type-aware linting, with no change in behaviour: `sheetRow`'s optional `height` parameter is declared `height?: number`, and `narrowEffect`, `synthesizeTable` and `synthesizeDocument` spell their never-failing return type `Effect<A>` instead of `Effect<A, never>`.

- [#194](https://github.com/thomasfosterau/effect-document/pull/194) [`ee78713`](https://github.com/thomasfosterau/effect-document/commit/ee78713d16674a818c999bd9f764c71c700fbced) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - Write profiles are now checked by a property test, and writers render their profiles exhaustively ([#109](https://github.com/thomasfosterau/effect-document/issues/109)).

  - New in the core: `TagsOf<F>` (the node tags a feature set names) and `InlineOf<F>`, `BlockOf<F>`, `CellOf<F>` and `ShapeOf<F>` (the nodes a `Doc<F>` may hold), plus the `isNodeIn(profile, node)` guard. The DOCX, PPTX, PDF and RTF writers render through tables exhaustive over these, so adding a feature to a profile without a writer for it is a compile error.
  - **PDF:** inline code leaves the `PdfWrite` profile: a monospace run that fills a line reads back as a code block, so converting to PDF now reports inline code as a loss.
  - **DOCX:** hyperlinks take their look from a `Hyperlink` character style instead of a direct underline, so they no longer read back wrapped in `Underline`; every list gets its own numbering instance, so adjacent lists stay separate; a heading that leads a list item keeps its heading style and reads back as a `Header`.
  - **TSV:** a line of tabs is a row of empty fields rather than a blank line, so the reader no longer drops it.
  - **RTF:** a node outside the RTF profile, in a document handed to the writer with `trustAs`, is dropped instead of throwing.

- [#165](https://github.com/thomasfosterau/effect-document/pull/165) [`286249e`](https://github.com/thomasfosterau/effect-document/commit/286249e7b9f794d79d0475f8a63cbee48d621d08) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - Publish built ESM and declarations: every entry point's `exports` now resolves to `dist/` (one bundle per subpath, `sideEffects: false`) instead of the TypeScript sources, and the `effect` peer range is `>=4.0.0-rc.118`.

  Errors are Schema tagged errors throughout. The core's `ParseError`, `WriteError`, `ProfileViolation` and `ConversionError` keep their tags and fields. In `@thomasfosterau/effect-pdf/cos`, `PdfSyntaxError` and `PdfFilterError` are tagged errors constructed from an options object (`new PdfSyntaxError({ reason, offset })`, `new PdfFilterError({ filter, reason })`) with the same `message` text, and `rewritePdf` refuses an encrypted file with the new `PdfEncryptedError`. `@thomasfosterau/effect-iwork/codec`'s `IworkError` keeps its tag, fields and `message`, and its reasons are also exported as the `IworkErrorReason` schema. The OOXML readers report a missing part as an `OpcError` of the new kind `"MissingPart"` (the `ParseError`'s `cause`) instead of a bare `Error`, and the XLSX writer's failure for a document without worksheets now reads `document contains no worksheets to write`.

  Fixes: an RTF control word named like an `Object.prototype` member (`\constructor`) no longer injects that member's text. Additions: `ComponentPathOrder` (component paths in natural order, as an `Order`; `compareComponentPaths` now returns an `Ordering`), the `ResolvedLimits` type behind `DEFAULT_BUNDLE_LIMITS`, the named `VarintRead` that `readVarint` returns, and a doc comment on every export.

- Updated dependencies [[`6d725f0`](https://github.com/thomasfosterau/effect-document/commit/6d725f09bfcff05196c598540e3945f3d671f94d), [`574c067`](https://github.com/thomasfosterau/effect-document/commit/574c067407cd2cf4473258f13c4ae3fdf7820f75), [`bd639a7`](https://github.com/thomasfosterau/effect-document/commit/bd639a7a318d5de3b40f14b5584c45a2d9f6d702), [`cb5fe2c`](https://github.com/thomasfosterau/effect-document/commit/cb5fe2ca0e443fc7911424d728f8f5560d920de2), [`3d5d706`](https://github.com/thomasfosterau/effect-document/commit/3d5d706b7303027ed0d42e2dfdb5da17ccd2c090), [`1411a17`](https://github.com/thomasfosterau/effect-document/commit/1411a17e1c2c4effd6852cd7207fe8cd7d865e48), [`87fc1a7`](https://github.com/thomasfosterau/effect-document/commit/87fc1a7ccde3cfc3bcfe43404fbdfe1b1695b940), [`ee78713`](https://github.com/thomasfosterau/effect-document/commit/ee78713d16674a818c999bd9f764c71c700fbced), [`5ffbd4a`](https://github.com/thomasfosterau/effect-document/commit/5ffbd4a99b8b5faa8e152743cf9a1e0dbdb309f9), [`666dff0`](https://github.com/thomasfosterau/effect-document/commit/666dff09a95e5ae8454965d573644e609f0fe5f2), [`3fe668f`](https://github.com/thomasfosterau/effect-document/commit/3fe668f4cbc81a126b298718f77a3c18437a4f54), [`286249e`](https://github.com/thomasfosterau/effect-document/commit/286249e7b9f794d79d0475f8a63cbee48d621d08), [`56a9bf4`](https://github.com/thomasfosterau/effect-document/commit/56a9bf43c36838d0b24264122125ae4b7e306b42)]:
  - @thomasfosterau/effect-document@0.2.0
