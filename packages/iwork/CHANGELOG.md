# @thomasfosterau/effect-iwork

## 0.1.0

### Minor Changes

- e47a449: Add experimental, read-only Apple iWork support (Pages / Numbers / Keynote) plus
  a dependency-free container codec.

  iWork '13+ files are reverse-engineered binary bundles - a zip of `.iwa`
  components holding Protobuf messages wrapped in a non-standard Snappy variant.
  This adds `@thomasfosterau/effect-iwork`: a from-scratch, dependency-free
  codec for the whole container stack (the Snappy _block_ format, IWA chunk
  framing, a generic schema-free Protobuf wire reader, the archived-object stream,
  and the zip-bundle opener), verified byte-for-byte against real Apple files.

  On top of it, read-only readers extract text:

  - **Keynote** (`.key`): slide text -> a presentation document (validated against a
    real Apple `.key` fixture).
  - **Pages** (`.pages`): body text -> a prose document (best-effort; no public
    Pages fixtures exist to validate against).
  - **Numbers** (`.numbers`): sheet structure (names -> empty worksheets); cell
    values are deferred (Numbers stores them in a hand-packed binary blob).

  Password-protected documents are detected (top-level `.iwph`) and refused.
  Writing iWork files requires the proprietary, version-specific object-graph
  schemas and is a future phase. The readers are experimental and version-sensitive.

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

- bd639a7: Profiles no longer overclaim (#109).

  `Format<R, W = R>` now has separate `readProfile` and `writeProfile` fields in place of `profile`. A format's write profile is what its writer preserves through `read(write(doc))`, and `convert` narrows to it, so anything a writer would silently drop or downgrade is now reported in the loss report.

  Trimmed to what round-trips today:

  - **XLSX:** new `Xlsx` (write) and `XlsxRead` profiles replace the full `Spreadsheet` profile. Columns, merges, styles, rich text, attributes and dates are not preserved.
  - **DOCX:** code blocks, block quotes, divs, line blocks, rules, inline code and quotations are not preserved.
  - **PPTX and RTF:** headers are not preserved.
  - **PDF:** new `PdfWrite` profile. Block quotes, rules, line breaks, underline and strikeout are not preserved.

  A new integration test round-trips a sample of every write-profile feature for every format, so profile drift fails CI.

- 4d29070: iWork codec hardening:

  - Snappy: the preamble is capped (64 MiB per block, and no more than the input can expand to), and every copy offset, copy length and literal is checked against the input and output. A block must produce exactly its declared length. `dechunk` caps a whole stream at 256 MiB (`maxLength`).
  - Archive stream: ArchiveInfo and payload lengths are checked against the buffer, and a missing identifier, type or length is an error instead of 0. Object identifiers are exact `bigint`s.
  - Protobuf: fixed-width fields keep their raw bytes. New `getDouble`, `getFloat`, `getBigInt` (`uint64`, `int64`, `sint64`), `getSint` and `getPacked` helpers. Varints above 2^53 keep their exact value.
  - Errors: the codec fails only with a typed `IworkError` that carries a reason, the component, the object id and the byte offset. `openBundle`, `decodeComponent`, `decodeAll` and `decodeIwa` return a `Result`. The readers keep the location in the `ParseError` and take a `lenient` option that skips a bad component with a logged warning.
  - Memory: only `Index/*.iwa` components (and `Index.zip`) are inflated, under entry-count, entry-size and total-size limits. Media is read on demand with `bundle.readEntry`. `openBundleDirectory` opens an unzipped package directory through `FileSystem`.

- 378df7a: Read iWork Protobuf fields and `.iwa` chunk headers with
  `@thomasfosterau/effect-parse`.

  - Truncated fields are now errors. A fixed-width or length-delimited field
    that ran past the end of its message used to yield `NaN` or silently
    shortened bytes. `parseMessage`, `readVarint` and `dechunk` now throw a
    positioned `ParseError` (e.g. "length-delimited field needs 5 bytes, only 1
    left" at its offset).
  - New `varint`, `field` and `message` parsers are exported for use in larger
    byte grammars.
  - Output is unchanged on the fixtures: all 119 `.iwa` streams dechunk
    identically, and all 1,271 top-level payloads parse identically. Reading is
    within about 15% of the previous speed.

- 2db89b2: iWork reader fixes:

  - A zip with no `Index/*.iwa` components fails with a typed reason instead of reading as an empty document. A `.docx` or another zip gives `NotIwork`, and an iWork '09 package (`index.apxl`, `index.xml`, or their `.gz` forms) gives `LegacyIwork09Unsupported`.
  - Keynote slide components are ordered by their numeric id (`Slide-8060` before `Slide-10000`), not lexicographically. Suffixed components (`Slide-NNNN-2.iwa`) are now read as slides too. `componentPaths` uses the new `compareComponentPaths` natural sort.
  - Numbers sheets follow the order of `TN.DocumentArchive.sheets` instead of zip entry order.

- Updated dependencies [6d725f0]
- Updated dependencies [574c067]
- Updated dependencies [bd639a7]
- Updated dependencies [3d5d706]
- Updated dependencies [87fc1a7]
- Updated dependencies [56a9bf4]
  - @thomasfosterau/effect-document@0.2.0
