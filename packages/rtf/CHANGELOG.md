# @thomasfosterau/effect-rtf

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

- [#9](https://github.com/thomasfosterau/effect-document/pull/9) [`b8a7a3f`](https://github.com/thomasfosterau/effect-document/commit/b8a7a3f5fa140005574c4a6f7239432ecdb63fe6) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - Move the RTF lexer and A1 references onto `@thomasfosterau/effect-parse`.

  - The RTF reader now lexes with a compiled effect-parse grammar (groups, control words with signed parameters, control symbols, `\'hh` escapes, text) and interprets the tokens. Output is unchanged, and it is about 20% faster.
  - `parseA1` is a parser too, and now rejects row 0 (`"A0"`), which used to produce row -1.
  - New: `parseA1Absolute` for `$`-pinned references (`"$B$3"`) and `parseA1Range` for ranges (`"A1:B2"`). The `a1Cell`, `a1AbsoluteCell` and `a1Range` parsers are exported for use in larger grammars.

- [#6](https://github.com/thomasfosterau/effect-document/pull/6) [`407bca5`](https://github.com/thomasfosterau/effect-document/commit/407bca5d098ab1dee14da5e5317aacfa2ec271d6) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - Add DOCX (Word), PPTX (PowerPoint) and RTF formats, each with its own profile.

  - **DOCX** (WordprocessingML): reads/writes headings, runs (bold/italic/ underline/strike/super/sub/small-caps), hyperlinks, bullet/ordered lists and tables.
  - **PPTX** (PresentationML): reads/writes a structurally valid deck of slides whose text-box / placeholder shapes hold paragraphs, headings and lists.
  - **RTF**: reads/writes paragraphs and headings with bold/italic/underline/ strike runs.

  Each format defines its own subset profile (`Docx`, `Pptx`, `Rtf`), so they exercise the conversion machinery across document families: `Rtf → Docx` widens for free, while `Docx → Rtf` and `Pptx → Docx`/`Rtf` narrow with a loss report (links to text, lists to paragraphs, slides flattened to prose, tables dropped).

  Internally, the OOXML XML parser and a new OPC packaging helper are shared across xlsx/docx/pptx in the shared OOXML module. The XLSX reader now also round-trips formula cells.

### Patch Changes

- [#178](https://github.com/thomasfosterau/effect-document/pull/178) [`182d0ea`](https://github.com/thomasfosterau/effect-document/commit/182d0ea632110ffb1faf857020790c8171fe50f1) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - Depend on `@thomasfosterau/effect-parse` `^0.2.0` (was `^0.1.0`), whose `Parser.compile` is now `Compiler.jit`.

  - `scanCsvStream` (and so the CSV reader's `readStream`) runs a compiled row grammar, memoized per dialect and options like the whole-text one: about twice as fast on a 4 MB file. Rows and errors are unchanged.
  - The `a1AbsoluteCell` and `a1Range` parsers (`parseA1Absolute`, `parseA1Range`) are compiled too, like `a1Cell`.

- [#194](https://github.com/thomasfosterau/effect-document/pull/194) [`ee78713`](https://github.com/thomasfosterau/effect-document/commit/ee78713d16674a818c999bd9f764c71c700fbced) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - Write profiles are now checked by a property test, and writers render their profiles exhaustively ([#109](https://github.com/thomasfosterau/effect-document/issues/109)).

  - New in the core: `TagsOf<F>` (the node tags a feature set names) and `InlineOf<F>`, `BlockOf<F>`, `CellOf<F>` and `ShapeOf<F>` (the nodes a `Doc<F>` may hold), plus the `isNodeIn(profile, node)` guard. The DOCX, PPTX, PDF and RTF writers render through tables exhaustive over these, so adding a feature to a profile without a writer for it is a compile error.
  - **PDF:** inline code leaves the `PdfWrite` profile: a monospace run that fills a line reads back as a code block, so converting to PDF now reports inline code as a loss.
  - **DOCX:** hyperlinks take their look from a `Hyperlink` character style instead of a direct underline, so they no longer read back wrapped in `Underline`; every list gets its own numbering instance, so adjacent lists stay separate; a heading that leads a list item keeps its heading style and reads back as a `Header`.
  - **TSV:** a line of tabs is a row of empty fields rather than a blank line, so the reader no longer drops it.
  - **RTF:** a node outside the RTF profile, in a document handed to the writer with `trustAs`, is dropped instead of throwing.

- [#180](https://github.com/thomasfosterau/effect-document/pull/180) [`43e873d`](https://github.com/thomasfosterau/effect-document/commit/43e873dc7567f5f83496d3b45602d798b84e1a6a) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - The RTF reader decodes cp1252 (`\ansicpg1252`, `\fcharset0`, and the fallback for unsupported code pages such as 437 and 850) by table instead of through `TextDecoder("windows-1252")`, so bytes 0x80–0x9F come out as `€`, `“`, `”`, `–` and the rest of cp1252 on Node 22 too, where `TextDecoder` returned their Latin-1 C1 control characters.

- [#148](https://github.com/thomasfosterau/effect-document/pull/148) [`c78e485`](https://github.com/thomasfosterau/effect-document/commit/c78e4855048638f0106ef3fd802cb75a9015515c) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - Fix the RTF reader's character decoding, formatting state and destinations.

  - `\'hh` escapes are decoded through the active font's `\fcharset` / `\cpg` or the document's `\ansicpg` (cp1252 `\'93` is now `“`), and double-byte code pages (932, 936, 949, 950) combine lead and trail bytes.
  - `Bytes` input is read as 7-bit RTF: 8-bit bytes go through the code page instead of being decoded as UTF-8.
  - `\ucN` sets the `\u` fallback length, a `\'hh` fallback is skipped, `\u` surrogate pairs combine, and an out-of-range `\u` parameter fails with a `ParseError` instead of a defect.
  - `\plain` resets character formatting. Special-character words (`\rquote`, `\emdash`, `\bullet`, ...) and `\-` / `\_` produce their characters.
  - `\cell` separates cells with a tab; `\row`, `\sect`, `\page` and `\column` break paragraphs.
  - Footnotes, `\v` hidden text, `\deleted` revisions, `\fldinst`, `\listtext` and many unstarred destinations (`annotation`, `object`, `shp`, `xe`, `header*`, `rsidtbl`, ...) are no longer read as body text.
  - `\binN` data is skipped; `\tab-y` keeps its hyphen; text after the outermost group is ignored; input that doesn't start with `{\rtf` fails with a `ParseError`.

- [#152](https://github.com/thomasfosterau/effect-document/pull/152) [`1b83198`](https://github.com/thomasfosterau/effect-document/commit/1b83198b03565c43feeb2143bb9a928d231b5d12) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - Fix the RTF writer's character escaping and header, and round-trip headings.

  - Characters above U+FFFF are written as a signed UTF-16 surrogate pair (`\u-10179?\u-8704?`), and control characters as `\uN` instead of raw.
  - The header declares `\ansicpg1252` and `\uc1`, and has a font table (`\f0` Helvetica, `\f1` Courier New), a colour table and a stylesheet, so `\deff0` points at a real font.
  - Headings are written with the `heading N` styles (`\sN\outlinelevelN`), and the reader maps `\outlinelevelN` and heading styles back to `Header`.
  - The writer's switches are exhaustive over the profile, so a feature added to the profile without writer support is a compile error.
  - New `RtfWriterOptions`: `lineEnding`, `font`, `fontSize`, `paperWidth` / `paperHeight` and `marginLeft` / `marginRight` / `marginTop` / `marginBottom`.

- [#165](https://github.com/thomasfosterau/effect-document/pull/165) [`286249e`](https://github.com/thomasfosterau/effect-document/commit/286249e7b9f794d79d0475f8a63cbee48d621d08) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - Publish built ESM and declarations: every entry point's `exports` now resolves to `dist/` (one bundle per subpath, `sideEffects: false`) instead of the TypeScript sources, and the `effect` peer range is `>=4.0.0-rc.118`.

  Errors are Schema tagged errors throughout. The core's `ParseError`, `WriteError`, `ProfileViolation` and `ConversionError` keep their tags and fields. In `@thomasfosterau/effect-pdf/cos`, `PdfSyntaxError` and `PdfFilterError` are tagged errors constructed from an options object (`new PdfSyntaxError({ reason, offset })`, `new PdfFilterError({ filter, reason })`) with the same `message` text, and `rewritePdf` refuses an encrypted file with the new `PdfEncryptedError`. `@thomasfosterau/effect-iwork/codec`'s `IworkError` keeps its tag, fields and `message`, and its reasons are also exported as the `IworkErrorReason` schema. The OOXML readers report a missing part as an `OpcError` of the new kind `"MissingPart"` (the `ParseError`'s `cause`) instead of a bare `Error`, and the XLSX writer's failure for a document without worksheets now reads `document contains no worksheets to write`.

  Fixes: an RTF control word named like an `Object.prototype` member (`\constructor`) no longer injects that member's text. Additions: `ComponentPathOrder` (component paths in natural order, as an `Order`; `compareComponentPaths` now returns an `Ordering`), the `ResolvedLimits` type behind `DEFAULT_BUNDLE_LIMITS`, the named `VarintRead` that `readVarint` returns, and a doc comment on every export.

- Updated dependencies [[`6d725f0`](https://github.com/thomasfosterau/effect-document/commit/6d725f09bfcff05196c598540e3945f3d671f94d), [`574c067`](https://github.com/thomasfosterau/effect-document/commit/574c067407cd2cf4473258f13c4ae3fdf7820f75), [`bd639a7`](https://github.com/thomasfosterau/effect-document/commit/bd639a7a318d5de3b40f14b5584c45a2d9f6d702), [`3d5d706`](https://github.com/thomasfosterau/effect-document/commit/3d5d706b7303027ed0d42e2dfdb5da17ccd2c090), [`87fc1a7`](https://github.com/thomasfosterau/effect-document/commit/87fc1a7ccde3cfc3bcfe43404fbdfe1b1695b940), [`ee78713`](https://github.com/thomasfosterau/effect-document/commit/ee78713d16674a818c999bd9f764c71c700fbced), [`5ffbd4a`](https://github.com/thomasfosterau/effect-document/commit/5ffbd4a99b8b5faa8e152743cf9a1e0dbdb309f9), [`286249e`](https://github.com/thomasfosterau/effect-document/commit/286249e7b9f794d79d0475f8a63cbee48d621d08), [`56a9bf4`](https://github.com/thomasfosterau/effect-document/commit/56a9bf43c36838d0b24264122125ae4b7e306b42)]:
  - @thomasfosterau/effect-document@0.2.0
