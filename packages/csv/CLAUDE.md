# @thomasfosterau/effect-csv (packages/csv)

CSV and TSV for the core's `Csv` profile: dialects (`dialect.ts`), the effect-parse grammar and the chunked streaming scanner (`scanner.ts`), the reader with type inference (`reader.ts`), the writer (`writer.ts`), and seeded synthetic data (`synthesize.ts`).

## Boundary

Peers: `effect`; dependencies `@thomasfosterau/effect-document` and `@thomasfosterau/effect-parse` (import its subpaths `/Parser`, `/Token`, `/ParserStream`, `/SyntaxError`, …). `.fallowrc.json` zone `csv` may import `core` only.

## Invariants

- **A CSV document is one `Worksheet`** of `CellText` / `CellNumber` / `CellBoolean` / `CellBlank`, with the header row as column names: `treatFirstRowAsHeader` decides, and unset the reader sniffs it (a text first row over a column of numbers or booleans; owner decision on #88). The scanners see raw strings only, so unset means no header there. The reader never emits another node.
- **Type inference is opt-out and lossless to turn off**: `inferTypes: false` keeps every value a text cell exactly as written. It types whole columns by default (`inference: "column"`, owner decision on #88); `"cell"` is the opt-in.
- **Whole-text and streaming scans agree.** `scanCsv` and `scanCsvStream` use the same row grammar; a field, a quoted line break or a CRLF split across stream chunks parses as if it were not. A whole-text failure carries its source position; a streaming one is positioned within the unconsumed buffer, so it carries none.
- **The grammars are compiled (`Compiler.jit`) and memoized** per dialect-and-options key, least recently used dropped at 32 entries: the whole-text grammar (`tableParser`), the streaming row grammar (`rowParser`, keyed without `skipRows`, which the stream drops before parsing). `ParserStream.parseMany` runs the compiled row grammar compiled and re-runs a failing row interpreted, so streaming errors are the interpreter's.
- **Synthesis is reproducible per seed**: the same `SynthesisSpec` with the same `seed` yields the same table (a Lehmer generator, row-major); without a seed the generator is seeded from Effect's `Random`.
