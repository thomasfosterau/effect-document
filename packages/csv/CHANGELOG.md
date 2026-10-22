# @thomasfosterau/effect-csv

## 0.1.0

### Minor Changes

- c6badbd: Rewrite the CSV scanner on `@thomasfosterau/effect-parse`.

  - Quoted fields may now contain line breaks (RFC 4180), so fields the CSV
    writer quotes for embedded newlines read back intact.
  - Bare CR line endings are accepted (previously a bare `\r` inside a line hung
    the scanner).
  - An unclosed quote is a `ParseError` with its row and column, instead of being
    silently closed at the end of the line.
  - New `scanCsvStream(chunks, dialect, options)` scans a `Stream` of text chunks
    and emits each row as soon as it is complete. `readStream` uses it, so rows
    are no longer all scanned up front.
  - `scanCsv` uses a compiled, cached grammar: about 14x faster on a 4.5 MB file.

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

### Patch Changes

- a69c912: Fix several CSV scanner bugs.

  - A wrapper inside an unquoted field is now a literal character, so
    `12" pizza,3` no longer swallows the following records. Text after a closing
    quote is still kept (`"a"b` reads as `ab`). The old behaviour, where quoted
    segments may start anywhere in a field, is available as `quoteAnywhere`.
  - An empty `wrapper` turns quoting off instead of breaking the parser.
  - Multi-character separators are matched whole, so fields may contain their
    characters (`a|b||c` with separator `||`).
  - `skipRows` counts CRLF, LF and bare CR line endings, in `scanCsv` and
    `scanCsvStream` (a CRLF may be split across chunks).
  - `trimWhitespace` keeps whitespace inside quoted fields.
  - Without headers, every row must be as wide as the first unless
    `allowVariableColumns` is set. Column-count and syntax errors both report
    the 0-based source row in `position.row`, counting skipped, blank, comment
    and quoted lines.
  - Stream syntax errors now carry a source position, and an unclosed quote reads
    "Unclosed quoted field: expected a closing quote" in both scanners.
  - With `treatFirstRowAsHeader`, `providedHeaders` now replace the header row
    instead of being ignored.
  - The compiled-parser cache evicts the least recently used grammar instead of
    clearing itself.
  - A leading byte order mark is ignored for text input.

- f9eb32e: Stop CSV type inference from corrupting values, and make it configurable.

  - Only plain decimals (`-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?`) with at most 15
    significant digits are read as numbers. `007`, ZIP codes, `0x1F`, `0b11`,
    `+1`, `12`, `Infinity` and long IDs now stay text.
  - Booleans are matched case-insensitively, so Excel's `TRUE`/`FALSE` read as
    booleans.
  - New inference options: `inference: "column"` types a whole column by all of
    its values (per-cell stays the default); `booleans` and
    `booleansCaseSensitive`; `decimalChar` and `groupChar` (CSVW names);
    `percent`; and `nullValues` for values read as blank cells.
  - `inferCell` takes the same options as an optional second argument.
  - The `inferTypes` docs describe what inference loses.

- f2d1020: Fix CSV writer data loss and add output options.

  - A row holding a single blank cell is written as `""` instead of an empty
    line, which the reader dropped.
  - Number cells are written as their shortest round-trip decimal, never in
    exponent form (`1e21` is written as `1000000000000000000000`). Override with
    `formatNumber`; `formatCsvNumber` is the default.
  - Fields with leading or trailing whitespace are quoted, and so are fields
    starting with the new `lineCommentMarker` option, so they read back intact.
  - New `escapeFormulae` option guards against CSV (formula) injection: text
    starting with `=`, `+`, `-`, `@`, a tab or a CR is prefixed with `'` and
    quoted. Off by default.
  - New `quoting` option: `minimal` (the default), `all`, `nonNumeric` or
    `none`. With `none`, writing fails with a `WriteError` if a field can't be
    read back without quotes.
  - New `bom`, `headers` and `padRows` options.
  - New `renderCsvStream` renders a `Stream` of `SheetRow`s to a `Stream` of
    CSV text, one chunk per row.
  - The line break is documented as the dialect's `linebreak` (LF by default).
    The new `Rfc4180Dialect` writes CRLF.

- bd639a7: Profiles no longer overclaim (#109).

  `Format<R, W = R>` now has separate `readProfile` and `writeProfile` fields in place of `profile`. A format's write profile is what its writer preserves through `read(write(doc))`, and `convert` narrows to it, so anything a writer would silently drop or downgrade is now reported in the loss report.

  Trimmed to what round-trips today:

  - **XLSX:** new `Xlsx` (write) and `XlsxRead` profiles replace the full `Spreadsheet` profile. Columns, merges, styles, rich text, attributes and dates are not preserved.
  - **DOCX:** code blocks, block quotes, divs, line blocks, rules, inline code and quotations are not preserved.
  - **PPTX and RTF:** headers are not preserved.
  - **PDF:** new `PdfWrite` profile. Block quotes, rules, line breaks, underline and strikeout are not preserved.

  A new integration test round-trips a sample of every write-profile feature for every format, so profile drift fails CI.

- Updated dependencies [6d725f0]
- Updated dependencies [574c067]
- Updated dependencies [bd639a7]
- Updated dependencies [3d5d706]
- Updated dependencies [87fc1a7]
- Updated dependencies [56a9bf4]
  - @thomasfosterau/effect-document@0.2.0
