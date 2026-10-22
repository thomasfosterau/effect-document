# @thomasfosterau/effect-ooxml

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

- 3d5d706: Split into a monorepo: a core package plus one package per format family.

  - `@thomasfosterau/effect-document` is now the core only: the schema, the
    profile system, the Reader/Writer/Format abstractions and `convert`. It no
    longer re-exports any format, and no longer depends on `fflate` or
    `@thomasfosterau/effect-parse`. The built-in profiles are also available on
    the new `./profiles` subpath, and the IO layer on `./io`.
  - `@thomasfosterau/effect-csv`: CSV/TSV (was `./csv`).
  - `@thomasfosterau/effect-ooxml`: `Xlsx`, `Docx` and `Pptx`
    namespaces, also on the `./xlsx`, `./docx` and `./pptx` subpaths.
  - `@thomasfosterau/effect-rtf`: RTF (was `./rtf`).
  - `@thomasfosterau/effect-iwork`: `Pages`, `Numbers`, `Keynote` and
    the container `Codec` namespaces, also on the `./pages`, `./numbers`,
    `./keynote` and `./codec` subpaths (the codec was `./iwork`).

  Migrate imports like so:

  ```ts
  // before
  import { convert, Csv, Xlsx } from "@thomasfosterau/effect-document";
  // after
  import { convert } from "@thomasfosterau/effect-document";
  import * as Csv from "@thomasfosterau/effect-csv";
  import { Xlsx } from "@thomasfosterau/effect-ooxml";
  ```

- 6f9eff3: Parse OOXML parts with an `@thomasfosterau/effect-parse` grammar.

  - Malformed XML now fails with a positioned `ParseError` (line, column and
    what was expected) rather than a bare `Error`. `parseXml` still throws;
    the new `parseXmlResult` returns a `Result` instead.
  - Closing tags must match their element (`<a><b></a>` is an error, reported
    at `<b>`), and content after the root element is rejected. A leading byte
    order mark is accepted.
  - Output is unchanged: all 617 XML parts of python-docx's Word test files
    parse identically, at the same speed (about 10% faster on a 7.9 MB
    worksheet).

- b8a7a3f: Move the RTF lexer and A1 references onto `@thomasfosterau/effect-parse`.

  - The RTF reader now lexes with a compiled effect-parse grammar (groups,
    control words with signed parameters, control symbols, `\'hh` escapes, text)
    and interprets the tokens. Output is unchanged, and it is about 20% faster.
  - `parseA1` is a parser too, and now rejects row 0 (`"A0"`), which used to
    produce row -1.
  - New: `parseA1Absolute` for `$`-pinned references (`"$B$3"`) and
    `parseA1Range` for ranges (`"A1:B2"`). The `a1Cell`, `a1AbsoluteCell` and
    `a1Range` parsers are exported for use in larger grammars.

- 407bca5: Add DOCX (Word), PPTX (PowerPoint) and RTF formats, each with its own profile.

  - **DOCX** (WordprocessingML): reads/writes headings, runs (bold/italic/
    underline/strike/super/sub/small-caps), hyperlinks, bullet/ordered lists and
    tables.
  - **PPTX** (PresentationML): reads/writes a structurally valid deck of slides
    whose text-box / placeholder shapes hold paragraphs, headings and lists.
  - **RTF**: reads/writes paragraphs and headings with bold/italic/underline/
    strike runs.

  Each format defines its own subset profile (`Docx`, `Pptx`, `Rtf`), so they
  exercise the conversion machinery across document families: `Rtf → Docx` widens
  for free, while `Docx → Rtf` and `Pptx → Docx`/`Rtf` narrow with a loss report
  (links to text, lists to paragraphs, slides flattened to prose, tables dropped).

  Internally, the OOXML XML parser and a new OPC packaging helper are shared
  across xlsx/docx/pptx in the shared OOXML module. The XLSX reader now also
  round-trips formula cells.

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

- 58fd4d6: DOCX correctness fixes.

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

- bd411b4: Harden the OOXML XML parser and OPC package handling.

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

- 7ddb4dd: PPTX reader:

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

- c66a018: XLSX reader: size each worksheet's grid by the cells that hold a value, so
  empty `<row>`s and style-only cells no longer extend it, and fail with a
  `ParseError` when the extent would exceed the new `maxCells` option (default
  5,000,000) instead of allocating the grid. `<dimension>` is honoured as a hint
  within that limit, and the writer now declares it to preserve trailing blank
  rows and columns.
- 100acfa: XLSX reader fixes:

  - Chartsheets, dialogsheets and macrosheets no longer fail the read. They come back as empty worksheets tagged `attr.data.kind`.
  - Rows and cells without an `r` attribute follow the previous row or cell instead of being placed by ordinal.
  - The dependent cells of a shared formula get the master formula translated by their offset, instead of an empty formula.
  - Phonetic guide text (`<rPh>`) is no longer concatenated into strings.
  - `_xHHHH_` escapes are decoded.
  - ISO 8601 `t="d"` cells read as `CellDate`.

- 990f266: The XLSX writer now uses the shared OOXML namespace constants and `zipParts` instead of its own copies.
- 56a9bf4: XLSX writer: emit files Excel opens without repair.

  - `NaN` and `±Infinity` are written as `#NUM!` error cells.
  - Characters that are invalid in XML 1.0 are `_xHHHH_`-encoded, and a literal `_xHHHH_` is escaped with `_x005F_`.
  - Sheet names are sanitised deterministically: invalid characters, empty names, `History`, more than 31 characters, and case-insensitive duplicates. See `sanitizeSheetNames`.
  - A leading `=` is stripped from formulas. `CellFormula.formula` is documented as never including it.
  - `<calcPr fullCalcOnLoad="1"/>` is emitted when a formula has no cached result.
  - `sst@count` is now the reference count, with `uniqueCount` as the distinct count.
  - `docProps/core.xml` and `docProps/app.xml` are written.

- Updated dependencies [6d725f0]
- Updated dependencies [574c067]
- Updated dependencies [bd639a7]
- Updated dependencies [3d5d706]
- Updated dependencies [87fc1a7]
- Updated dependencies [56a9bf4]
  - @thomasfosterau/effect-document@0.2.0
