# effect-pandoc

A **Pandoc-style document conversion toolkit** built on [Effect](https://effect.website): readers parse formats into a universal intermediate representation, writers render it back out, and `convert()` connects any reader to any writer.

```
        readers                                    writers
  CSV  ───────────┐                          ┌─────────────▶  CSV
  TSV  ───────────┤     ┌──────────────┐     ├─────────────▶  TSV
  XLSX ───────────┼────▶│ universal IR │─────┼─────────────▶  XLSX
  (more to come)  │     └──────────────┘     │  (more to come)
                  └──── Workbook ⇄ Document ─┘
```

## Features

- 🔁 **Format conversion** - `convert({ from, to, input })`, the `pandoc -f csv -t xlsx` equivalent
- 🌳 **Two-layer IR** - a Pandoc-style **Document AST** (headings, paragraphs, tables, inline formatting) plus a typed **tabular Workbook model**, with bridging between them
- 📑 **Native XLSX** - reads and writes real Excel files with no heavyweight dependencies (just [fflate](https://github.com/101arrowz/fflate) for zip)
- 📜 **CSV/TSV dialects** - quoting, escaping, comments, custom separators, type inference
- 🧬 **Schema-powered** - the whole IR is built on Effect Schema, so documents and workbooks serialize to/from JSON for free
- 🌊 **Streaming** - process large tabular files row-by-row with Effect Streams
- 🛡️ **Type safe** - typed cells, tagged errors, no `any`
- ⚡ **Bun-first** - Bun workspaces, tests, and builds

## Packages

| Package | Description |
|---|---|
| [`@effect-pandoc/core`](./packages/core) | The intermediate representation (Document AST + Workbook), Reader/Writer abstractions, and the `convert()` pipeline |
| [`@effect-pandoc/csv`](./packages/csv) | CSV/TSV reader & writer, streaming, data synthesis |
| [`@effect-pandoc/xlsx`](./packages/xlsx) | Native Excel (.xlsx) reader & writer |
| [`effect-csv`](./packages/effect-csv) | Backwards-compatible package preserving the original effect-csv v0.1.x API |

## Installation

```bash
bun add @effect-pandoc/core @effect-pandoc/csv @effect-pandoc/xlsx effect
```

## Quick start: convert CSV to Excel

```typescript
import { Effect } from "effect";
import { contentToBytes, convert, text } from "@effect-pandoc/core";
import * as Csv from "@effect-pandoc/csv";
import * as Xlsx from "@effect-pandoc/xlsx";

const program = Effect.gen(function* () {
  const xlsx = yield* convert({
    from: Csv.format,
    to: Xlsx.format,
    input: text("product,price\nLaptop,999.99\nMouse,24.99\n"),
  });

  yield* Effect.promise(() => Bun.write("products.xlsx", contentToBytes(xlsx)));
});

Effect.runPromise(program);
```

...and back: `convert({ from: Xlsx.format, to: Csv.format, input: bytes(data) })`.

## The intermediate representation

Like Pandoc, every format reads into (and writes from) a shared representation, so adding a format once connects it to every other format. There are two layers:

### The tabular layer: `Workbook`

The natural target for spreadsheet formats. Sheets hold grids of **typed** cells:

```typescript
import { cell, sheet, workbookOf } from "@effect-pandoc/core";

const workbook = workbookOf(
  sheet(
    "People",
    [
      [cell.str("alice"), cell.num(30), cell.bool(true)],
      [cell.str("bob"), cell.num(25), cell.empty()],
    ],
    ["name", "age", "active"] // headers
  )
);
```

### The document layer: `Document`

A Pandoc-style AST for document formats (Markdown, HTML, ... coming later). Tables are first-class blocks, so tabular data fits inside documents:

```typescript
import { Heading, Paragraph, Strong, document, str } from "@effect-pandoc/core";

const doc = document([
  new Heading({ level: 1, content: [str("Report")] }),
  new Paragraph({ content: [str("Sales were "), new Strong({ content: [str("up 12%")] })] }),
]);
```

### Bridging and serialization

```typescript
import { Schema } from "effect";
import { Document, documentToWorkbook, workbookToDocument } from "@effect-pandoc/core";

// Workbook -> Document: each sheet becomes a Table block
const doc = yield* workbookToDocument(workbook);

// Document -> Workbook: Table blocks become sheets
const wb = yield* documentToWorkbook(doc);

// The whole IR is Effect Schema-based: JSON in/out for free
const json = yield* Schema.encode(Document)(doc); // pandoc -t json, effectively
```

## Reading and writing directly

Each format package exposes its reader/writer for direct use (with format-specific options), plus a `format` bundle for `convert()`:

```typescript
import { Effect } from "effect";
import { text } from "@effect-pandoc/core";
import { makeCsvReader, makeCsvWriter } from "@effect-pandoc/csv";

// CSV -> Workbook with type inference (numbers, booleans, nulls)
const reader = makeCsvReader({ treatFirstRowAsHeader: true });
const workbook = yield* reader.readWorkbook!(text("name,age\nalice,30\n"));
// -> cell types: CellString, CellNumber

// Workbook -> CSV
const writer = makeCsvWriter();
const csv = yield* writer.writeWorkbook!(workbook);
```

```typescript
import { bytes } from "@effect-pandoc/core";
import { makeXlsxReader, makeXlsxWriter } from "@effect-pandoc/xlsx";

// .xlsx bytes -> Workbook (multi-sheet, typed cells)
const workbook = yield* makeXlsxReader().readWorkbook!(bytes(data));

// Workbook -> .xlsx bytes
const xlsx = yield* makeXlsxWriter().writeWorkbook!(workbook);
```

### Streaming CSV rows

```typescript
import { Stream, pipe } from "effect";
import { makeCsvReader } from "@effect-pandoc/csv";

const rows = makeCsvReader({ treatFirstRowAsHeader: true }).readRowStream!(text(bigCsv));

yield* pipe(
  rows,
  Stream.take(100),
  Stream.runForEach((row) => Effect.sync(() => console.log(row)))
);
```

### Synthesizing test data

```typescript
import { synthesizeWorkbook } from "@effect-pandoc/csv";

const workbook = yield* synthesizeWorkbook({
  columns: ["id", "email", "username"],
  quantity: 10_000,
  seed: 42, // reproducible
});
```

## Dependency-injection style

Every reader/writer is also available as an Effect service (Context tag + Layer) if you prefer wiring through the environment:

```typescript
import { Effect } from "effect";
import { CsvReaderTag, CsvReaderLive } from "@effect-pandoc/csv";

const program = Effect.gen(function* () {
  const reader = yield* CsvReaderTag;
  return yield* reader.readWorkbook!(text("a,b\n1,2"));
}).pipe(Effect.provide(CsvReaderLive));
```

## Backwards compatibility with effect-csv

The original `effect-csv` API (`csvRead`, `csvWrite`, `csvSynthesize`, `csvReadStream`, the `Csv` service, `TableData`, ...) is preserved unchanged in the `effect-csv` package, now implemented on top of `@effect-pandoc/csv`:

```typescript
import { csvRead, csvWrite } from "effect-csv"; // still works
```

New code should prefer `@effect-pandoc/csv` directly.

## Format support status

| Format | Read | Write | Notes |
|---|---|---|---|
| CSV / TSV | ✅ | ✅ | dialects, quoting, comments, streaming, type inference |
| XLSX | ✅ | ✅ | multi-sheet, shared/inline strings, numbers, booleans; no styles/formulas yet; dates round-trip as ISO strings |
| JSON (IR) | ✅ | ✅ | via Effect Schema encode/decode of `Document` / `Workbook` |
| Markdown | 🔜 | 🔜 | planned |
| HTML | 🔜 | 🔜 | planned |

## Examples

See the [examples](./examples/) directory:

```bash
bun run examples/convert-csv-to-xlsx.ts   # the headline conversion pipeline
bun run examples/document-ast.ts          # working with the document AST + JSON serialization
bun run examples/streaming.ts             # streaming rows + data synthesis
```

## Development

```bash
bun install        # install workspace dependencies
bun test           # run all package test suites
bun run typecheck  # tsc --noEmit across the workspace
bun run build      # bundle each package to dist/
```

## Why Effect?

- **Type-safe error handling** - `ParseError`/`WriteError`/`ConversionError` are part of every signature
- **Composability** - conversions are ordinary Effects; chain, retry, race, or parallelize them
- **Dependency injection** - readers and writers are services with Layers
- **Streaming** - memory-efficient processing of large files
- **Schema** - the IR validates and serializes itself

## License

MIT
