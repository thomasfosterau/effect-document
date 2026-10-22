# @thomasfosterau/effect-rtf

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

- c78e485: Fix the RTF reader's character decoding, formatting state and destinations.

  - `\'hh` escapes are decoded through the active font's `\fcharset` / `\cpg`
    or the document's `\ansicpg` (cp1252 `\'93` is now `“`), and double-byte
    code pages (932, 936, 949, 950) combine lead and trail bytes.
  - `Bytes` input is read as 7-bit RTF: 8-bit bytes go through the code page
    instead of being decoded as UTF-8.
  - `\ucN` sets the `\u` fallback length, a `\'hh` fallback is skipped, `\u`
    surrogate pairs combine, and an out-of-range `\u` parameter fails with a
    `ParseError` instead of a defect.
  - `\plain` resets character formatting. Special-character words (`\rquote`,
    `\emdash`, `\bullet`, ...) and `\-` / `\_` produce their characters.
  - `\cell` separates cells with a tab; `\row`, `\sect`, `\page` and `\column`
    break paragraphs.
  - Footnotes, `\v` hidden text, `\deleted` revisions, `\fldinst`, `\listtext`
    and many unstarred destinations (`annotation`, `object`, `shp`, `xe`,
    `header*`, `rsidtbl`, ...) are no longer read as body text.
  - `\binN` data is skipped; `\tab-y` keeps its hyphen; text after the
    outermost group is ignored; input that doesn't start with `{\rtf` fails
    with a `ParseError`.

- 1b83198: Fix the RTF writer's character escaping and header, and round-trip headings.

  - Characters above U+FFFF are written as a signed UTF-16 surrogate pair
    (`\u-10179?\u-8704?`), and control characters as `\uN` instead of raw.
  - The header declares `\ansicpg1252` and `\uc1`, and has a font table
    (`\f0` Helvetica, `\f1` Courier New), a colour table and a stylesheet, so
    `\deff0` points at a real font.
  - Headings are written with the `heading N` styles (`\sN\outlinelevelN`), and
    the reader maps `\outlinelevelN` and heading styles back to `Header`.
  - The writer's switches are exhaustive over the profile, so a feature added to
    the profile without writer support is a compile error.
  - New `RtfWriterOptions`: `lineEnding`, `font`, `fontSize`, `paperWidth` /
    `paperHeight` and `marginLeft` / `marginRight` / `marginTop` /
    `marginBottom`.

- Updated dependencies [6d725f0]
- Updated dependencies [574c067]
- Updated dependencies [bd639a7]
- Updated dependencies [3d5d706]
- Updated dependencies [87fc1a7]
- Updated dependencies [56a9bf4]
  - @thomasfosterau/effect-document@0.2.0
