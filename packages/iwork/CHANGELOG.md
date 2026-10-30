# @thomasfosterau/effect-iwork

## 0.1.0

### Minor Changes

- [#7](https://github.com/thomasfosterau/effect-document/pull/7) [`e47a449`](https://github.com/thomasfosterau/effect-document/commit/e47a449befe530adf98594e760349ed4eab443c1) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - Add experimental, read-only Apple iWork support (Pages / Numbers / Keynote) plus a dependency-free container codec.

  iWork '13+ files are reverse-engineered binary bundles - a zip of `.iwa` components holding Protobuf messages wrapped in a non-standard Snappy variant. This adds `@thomasfosterau/effect-iwork`: a from-scratch, dependency-free codec for the whole container stack (the Snappy _block_ format, IWA chunk framing, a generic schema-free Protobuf wire reader, the archived-object stream, and the zip-bundle opener), verified byte-for-byte against real Apple files.

  On top of it, read-only readers extract text:

  - **Keynote** (`.key`): slide text -> a presentation document (validated against a real Apple `.key` fixture).
  - **Pages** (`.pages`): body text -> a prose document (best-effort; no public Pages fixtures exist to validate against).
  - **Numbers** (`.numbers`): sheet structure (names -> empty worksheets); cell values are deferred (Numbers stores them in a hand-packed binary blob).

  Password-protected documents are detected (top-level `.iwph`) and refused. Writing iWork files requires the proprietary, version-specific object-graph schemas and is a future phase. The readers are experimental and version-sensitive.

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

### Patch Changes

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

- [#157](https://github.com/thomasfosterau/effect-document/pull/157) [`4d29070`](https://github.com/thomasfosterau/effect-document/commit/4d2907030818c01d3627a6528ddbd5f9887af0b5) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - iWork codec hardening:

  - Snappy: the preamble is capped (64 MiB per block, and no more than the input can expand to), and every copy offset, copy length and literal is checked against the input and output. A block must produce exactly its declared length. `dechunk` caps a whole stream at 256 MiB (`maxLength`).
  - Archive stream: ArchiveInfo and payload lengths are checked against the buffer, and a missing identifier, type or length is an error instead of 0. Object identifiers are exact `bigint`s.
  - Protobuf: fixed-width fields keep their raw bytes. New `getDouble`, `getFloat`, `getBigInt` (`uint64`, `int64`, `sint64`), `getSint` and `getPacked` helpers. Varints above 2^53 keep their exact value.
  - Errors: the codec fails only with a typed `IworkError` that carries a reason, the component, the object id and the byte offset. `openBundle`, `decodeComponent`, `decodeAll` and `decodeIwa` return a `Result`. The readers keep the location in the `ParseError` and take a `lenient` option that skips a bad component with a logged warning.
  - Memory: only `Index/*.iwa` components (and `Index.zip`) are inflated, under entry-count, entry-size and total-size limits. Media is read on demand with `bundle.readEntry`. `openBundleDirectory` opens an unzipped package directory through `FileSystem`.

- [#10](https://github.com/thomasfosterau/effect-document/pull/10) [`378df7a`](https://github.com/thomasfosterau/effect-document/commit/378df7af192eb1087aa35688b16f1bd2ca7e1aec) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - Read iWork Protobuf fields and `.iwa` chunk headers with `@thomasfosterau/effect-parse`.

  - Truncated fields are now errors. A fixed-width or length-delimited field that ran past the end of its message used to yield `NaN` or silently shortened bytes. `parseMessage`, `readVarint` and `dechunk` now throw a positioned `ParseError` (e.g. "length-delimited field needs 5 bytes, only 1 left" at its offset).
  - New `varint`, `field` and `message` parsers are exported for use in larger byte grammars.
  - Output is unchanged on the fixtures: all 119 `.iwa` streams dechunk identically, and all 1,271 top-level payloads parse identically. Reading is within about 15% of the previous speed.

- [#159](https://github.com/thomasfosterau/effect-document/pull/159) [`2db89b2`](https://github.com/thomasfosterau/effect-document/commit/2db89b26e40febb93b93a847423a0248e8af5aa7) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - iWork reader fixes:

  - A zip with no `Index/*.iwa` components fails with a typed reason instead of reading as an empty document. A `.docx` or another zip gives `NotIwork`, and an iWork '09 package (`index.apxl`, `index.xml`, or their `.gz` forms) gives `LegacyIwork09Unsupported`.
  - Keynote slide components are ordered by their numeric id (`Slide-8060` before `Slide-10000`), not lexicographically. Suffixed components (`Slide-NNNN-2.iwa`) are now read as slides too. `componentPaths` uses the new `compareComponentPaths` natural sort.
  - Numbers sheets follow the order of `TN.DocumentArchive.sheets` instead of zip entry order.

- [#165](https://github.com/thomasfosterau/effect-document/pull/165) [`286249e`](https://github.com/thomasfosterau/effect-document/commit/286249e7b9f794d79d0475f8a63cbee48d621d08) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - Publish built ESM and declarations: every entry point's `exports` now resolves to `dist/` (one bundle per subpath, `sideEffects: false`) instead of the TypeScript sources, and the `effect` peer range is `>=4.0.0-rc.118`.

  Errors are Schema tagged errors throughout. The core's `ParseError`, `WriteError`, `ProfileViolation` and `ConversionError` keep their tags and fields. In `@thomasfosterau/effect-pdf/cos`, `PdfSyntaxError` and `PdfFilterError` are tagged errors constructed from an options object (`new PdfSyntaxError({ reason, offset })`, `new PdfFilterError({ filter, reason })`) with the same `message` text, and `rewritePdf` refuses an encrypted file with the new `PdfEncryptedError`. `@thomasfosterau/effect-iwork/codec`'s `IworkError` keeps its tag, fields and `message`, and its reasons are also exported as the `IworkErrorReason` schema. The OOXML readers report a missing part as an `OpcError` of the new kind `"MissingPart"` (the `ParseError`'s `cause`) instead of a bare `Error`, and the XLSX writer's failure for a document without worksheets now reads `document contains no worksheets to write`.

  Fixes: an RTF control word named like an `Object.prototype` member (`\constructor`) no longer injects that member's text. Additions: `ComponentPathOrder` (component paths in natural order, as an `Order`; `compareComponentPaths` now returns an `Ordering`), the `ResolvedLimits` type behind `DEFAULT_BUNDLE_LIMITS`, the named `VarintRead` that `readVarint` returns, and a doc comment on every export.

- [#190](https://github.com/thomasfosterau/effect-document/pull/190) [`802034b`](https://github.com/thomasfosterau/effect-document/commit/802034b7d43b7d18f2ce905ed1ef5e4ea808a554) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - Align the zip-bomb limits of the OOXML and iWork readers, so both are configured and fail the same way:

  - OOXML: `OpcLimits` takes iWork's names, `maxEntrySize` (was `maxPartBytes`) and `maxTotalSize` (was `maxTotalBytes`), and every limit is optional (`?: number | undefined`; an explicit `undefined` keeps the default). The defaults are now iWork's: 10,000 entries, 256 MiB per part (was 100 MiB) and 512 MiB in total (was 500 MiB). The reader option is `limits?: OpcLimits` (was `Partial<OpcLimits>`).
  - iWork: `ResolvedLimits` is renamed `ResolvedBundleLimits`, to match OOXML's new `ResolvedOpcLimits`. A limit failure becomes a `ParseError` with `code: "LimitExceeded"`, as OOXML's does, and every reader `ParseError`'s `reason` now names the `IworkError` reason (`Failed to read keynote: Truncated: …`).
  - Both report a limit with the same messages: `more than N zip entries`, `<entry> is N bytes uncompressed, over the M-byte limit` and `the parts read exceed the N-byte total limit`.

- Updated dependencies [[`6d725f0`](https://github.com/thomasfosterau/effect-document/commit/6d725f09bfcff05196c598540e3945f3d671f94d), [`574c067`](https://github.com/thomasfosterau/effect-document/commit/574c067407cd2cf4473258f13c4ae3fdf7820f75), [`bd639a7`](https://github.com/thomasfosterau/effect-document/commit/bd639a7a318d5de3b40f14b5584c45a2d9f6d702), [`cb5fe2c`](https://github.com/thomasfosterau/effect-document/commit/cb5fe2ca0e443fc7911424d728f8f5560d920de2), [`3d5d706`](https://github.com/thomasfosterau/effect-document/commit/3d5d706b7303027ed0d42e2dfdb5da17ccd2c090), [`1411a17`](https://github.com/thomasfosterau/effect-document/commit/1411a17e1c2c4effd6852cd7207fe8cd7d865e48), [`87fc1a7`](https://github.com/thomasfosterau/effect-document/commit/87fc1a7ccde3cfc3bcfe43404fbdfe1b1695b940), [`ee78713`](https://github.com/thomasfosterau/effect-document/commit/ee78713d16674a818c999bd9f764c71c700fbced), [`5ffbd4a`](https://github.com/thomasfosterau/effect-document/commit/5ffbd4a99b8b5faa8e152743cf9a1e0dbdb309f9), [`666dff0`](https://github.com/thomasfosterau/effect-document/commit/666dff09a95e5ae8454965d573644e609f0fe5f2), [`3fe668f`](https://github.com/thomasfosterau/effect-document/commit/3fe668f4cbc81a126b298718f77a3c18437a4f54), [`286249e`](https://github.com/thomasfosterau/effect-document/commit/286249e7b9f794d79d0475f8a63cbee48d621d08), [`56a9bf4`](https://github.com/thomasfosterau/effect-document/commit/56a9bf43c36838d0b24264122125ae4b7e306b42)]:
  - @thomasfosterau/effect-document@0.2.0
