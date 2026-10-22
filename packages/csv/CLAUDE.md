# @thomasfosterau/effect-csv (packages/csv)

CSV and TSV for the core's `Csv` profile: dialects (`dialect.ts`), the effect-parse grammar and the chunked streaming scanner (`scanner.ts`), the reader with type inference (`reader.ts`), the writer (`writer.ts`), and seeded synthetic data (`synthesize.ts`).

## Boundary

Peers: `effect`; dependencies `@thomasfosterau/effect-document` and `@thomasfosterau/effect-parse` (import its subpaths `/Parser`, `/Token`, `/ParserStream`, `/SyntaxError`, …). `.fallowrc.json` zone `csv` may import `core` only.

## Invariants

- **A CSV document is one `Worksheet`** of `CellText` / `CellNumber` / `CellBoolean` / `CellBlank`, with the header row as column names when `treatFirstRowAsHeader` is set. The reader never emits another node.
- **Type inference is opt-out and lossless to turn off**: `inferTypes: false` keeps every value a text cell exactly as written.
- **Whole-text and streaming scans agree.** `scanCsv` and `scanCsvStream` use the same row grammar; a field, a quoted line break or a CRLF split across stream chunks parses as if it were not. A whole-text failure carries its source position; a streaming one is positioned within the unconsumed buffer, so it carries none.
- **The compiled whole-text grammar is memoized** per dialect-and-options key (`tableParsers`, cleared when it reaches 32 entries).
- **Synthesis is reproducible per seed**: the same `SynthesisSpec` with the same `seed` yields the same table (a Lehmer generator, row-major); without a seed the generator is seeded from Effect's `Random`.
