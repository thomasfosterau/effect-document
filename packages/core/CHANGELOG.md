# @thomasfosterau/effect-document

## 0.2.0

### Minor Changes

- 6d725f0: Deeply nested documents no longer overflow the stack in feature collection
  (`Profile.is`, `validate`, `collectFeatures`) or in the text collapse
  (`blocksToText`, `inlinesToText`, `cellToText`, `shapeToText`): these walks
  now use an explicit stack.

  New in core: `nestingDepth` / `blocksNestingDepth` (iterative),
  `DEFAULT_MAX_NESTING_DEPTH` (1000), `limitNestingDepth`, and an optional
  `ParseError.code` (`"LimitExceeded"`). The DOCX and PDF readers, whose
  nesting follows the input, take a `maxDepth` option and fail with a
  `LimitExceeded` ParseError past it.

- 574c067: Migrate to Effect 4. The `effect` peer dependency is now `^4.0.0`.

  - Node schemas use the Effect 4 Schema API (`Schema.Union([...])`,
    `Schema.Literals([...])`, `Schema.Record(key, value)`, `Schema.Codec`).
    Encode and decode with `Schema.encodeEffect` / `Schema.decodeEffect`.
  - `CellDate` still encodes to an ISO-8601 string (`Schema.DateFromString`).
  - `Profile.schema` is typed as `Schema.Codec<Doc<F>, DocumentEncoded>`.
  - `makeReaderTag` / `makeWriterTag` return `Context.Service` keys.

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

- 87fc1a7: Replace the two-layer IR (Document AST + tabular Workbook + legacy effect-csv shim) with a single, type-safe **profile-based universal document schema**.

  - **One schema** spanning prose, spreadsheets (a `Worksheet` block of typed cells), and presentations (a `SlideShow` block) — a Pandoc-superset with a structured + open attribute model.
  - **Profiles** are named subsets of the schema. Documents are phantom-typed `Doc<F>` so "subset of" is ordinary TypeScript assignability: readers return exactly their format's subset, and writers reject (at compile time) any document too rich to represent.
  - **`narrow`/`widen`** transform documents between subsets — widening is free, narrowing is lossy and reports exactly what was dropped or down-converted. **`convert`** widens or narrows automatically and returns a loss report.
  - CSV and XLSX are retrofitted onto the new schema (`Csv`/`Xlsx` profiles).

  Breaking: the old `Workbook`/`Sheet`/`Cell` IR, the `convert()` return shape (now `{ content, loss }`), and the `/legacy` entry point are removed. New subpath entry points `/schema` and `/profile` are added.

### Patch Changes

- 56a9bf4: XLSX writer: emit files Excel opens without repair.

  - `NaN` and `±Infinity` are written as `#NUM!` error cells.
  - Characters that are invalid in XML 1.0 are `_xHHHH_`-encoded, and a literal `_xHHHH_` is escaped with `_x005F_`.
  - Sheet names are sanitised deterministically: invalid characters, empty names, `History`, more than 31 characters, and case-insensitive duplicates. See `sanitizeSheetNames`.
  - A leading `=` is stripped from formulas. `CellFormula.formula` is documented as never including it.
  - `<calcPr fullCalcOnLoad="1"/>` is emitted when a formula has no cached result.
  - `sst@count` is now the reference count, with `uniqueCount` as the distinct count.
  - `docProps/core.xml` and `docProps/app.xml` are written.
