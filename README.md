# effect-document

A **type-safe, profile-based universal document schema** built on [Effect](https://effect.website) 4. One rich AST spans prose documents, spreadsheets, and presentations; **profiles** carve out named subsets of that schema; and the type system tracks which subset every document belongs to - so a reader returns exactly the subset its format produces, a writer only accepts what its format can represent, and converting between subsets tells you precisely what (if anything) was lost.

```
                 ┌──────────────────────────────────────────────┐
   CSV  ───read──▶            universal document schema           ─write──▶  CSV
   XLSX ───read──▶  prose · spreadsheets · presentations + attrs  ─write──▶  XLSX
                 └──────────────────────────────────────────────┘
                     ▲  Csv ⊆ Spreadsheet ⊆ Full   (profiles)  ▲
                     └──── widen (free) ─── narrow (lossy) ─────┘
```

## The idea

Parsing a CSV always produces a subset of what a spreadsheet can represent; writing an Excel workbook to CSV is *not* straightforward. effect-document encodes that asymmetry in the **types**:

- A **`Feature`** names one capability - a node kind (`block.header`, `cell.date`), or an attribute facet (`attr.style`).
- A **`Profile`** is a named set of allowed features (`Csv`, `Spreadsheet`, `Markdown`, `Html`, `Presentation`, `Full`).
- A document is phantom-typed **`Doc<F>`** with the features it's allowed to use. Because that phantom sits in a covariant position, **"subset of" is ordinary TypeScript assignability**:

```ts
const csvDoc: Doc<CsvFeature> = /* ... */;

const wider: Doc<SpreadsheetFeature> = csvDoc;   // ✅ widening is free (CSV ⊆ Spreadsheet)
csvWriter.write(fullDoc);                         // ❌ compile error: a full doc is too rich for CSV
```

So:

- **Readers** return `Doc<F>` for exactly their format's profile.
- **Writers** accept only `Doc<F>` - over-rich documents are a *compile-time* error; you must `narrow` first.
- **`narrow`** down-converts a document to a target profile and reports every drop/conversion.
- **`convert`** wires a reader to a writer, widening for free or narrowing (lossily) as needed.

## Installation

The core package holds the schema, profiles and conversion pipeline; each format family is its own package, so you install only the formats you use:

```bash
bun add effect @thomasfosterau/effect-document
bun add @thomasfosterau/effect-csv     # CSV / TSV
bun add @thomasfosterau/effect-ooxml   # XLSX, DOCX, PPTX
bun add @thomasfosterau/effect-rtf     # RTF
bun add @thomasfosterau/effect-pdf     # PDF
bun add @thomasfosterau/effect-iwork   # Pages, Numbers, Keynote (experimental, read-only)
```

`effect` is a peer dependency of every package.

## Quick start: convert CSV to Excel

```ts
import { Effect } from "effect";
import { contentToBytes, convert, text } from "@thomasfosterau/effect-document";
import * as Csv from "@thomasfosterau/effect-csv";
import { Xlsx } from "@thomasfosterau/effect-ooxml";

const program = Effect.gen(function* () {
  // CSV ⊆ Spreadsheet, so this is a free widening - loss.isLossless === true
  const { content, loss } = yield* convert({
    from: Csv.format,
    to: Xlsx.format,
    input: text("product,price\nLaptop,999.99\nMouse,24.99\n"),
  });

  yield* Effect.promise(() => Bun.write("products.xlsx", contentToBytes(content)));
});

Effect.runPromise(program);
```

Going the other way (`Xlsx.format → Csv.format`) **narrows**: dates become ISO text, formulas collapse to their cached result, extra sheets are dropped - and `loss.entries` tells you exactly what happened.

## The schema

Every node is an Effect `Schema` class, so the whole tree encodes to / decodes from plain JSON.

```ts
import { document, header, para, str, strong, worksheet, cell, slide, slideShow, textBox } from "@thomasfosterau/effect-document";

// prose
const report = document([
  header(1, [str("Report")]),
  para([str("Sales were "), strong([str("up 12%")])]),
]);

// a spreadsheet is part of the same schema (a `Worksheet` block of typed cells)
const sheet = document([
  worksheet("Sales", [
    [cell.text("North"), cell.number(42000), cell.date(new Date())],
    [cell.text("South"), cell.number(38500), cell.blank()],
  ], ["region", "revenue", "as_of"]),
]);

// so is a presentation (a `SlideShow` block of slides)
const deck = document([slideShow([slide([textBox([para([str("Hello")])])])])]);
```

The vocabulary is a Pandoc superset: the full inline/block set (emphasis, links, images, code, math, lists, block quotes, figures, divs, tables…), a faithful spreadsheet model (`Worksheet` with typed `CellText`/`CellNumber`/`CellBoolean`/`CellDate`/`CellError`/`CellBlank`/`CellFormula`/`CellRichText`, merges, columns), and a presentation model (`SlideShow` → `Slide` → shapes + speaker notes).

### Custom attributes

Most nodes carry an optional `attr`: well-known `id`/`classes`, structured `style`, and an open `data` map for **arbitrary, format-specific custom attributes**. Which facets a profile permits is its `AttrPolicy` - Markdown allows `id`/`classes` only, HTML/OOXML allow `style` and key/values too - and narrowing strips facets the target can't represent.

## Profiles & subsets

```ts
import { Profiles, defineProfile, narrow } from "@thomasfosterau/effect-document";

// conformance checks
Profiles.Markdown.is(report);        // true
Profiles.Csv.is(sheet);              // false (dates & a header aren't in the CSV subset)

// validate, failing with the exact unsupported features
const checked = yield* Profiles.Csv.validate(sheet);
// -> ProfileViolation { unsupported: ["cell.date", ...] }

// narrow to a subset, learning what was lost
const { document: csv, loss } = narrow(sheet, Profiles.Csv);
loss.entries; // [{ feature: "cell.date", action: "converted", detail: "date cell converted to ISO text" }, ...]
```

Defining your own format's subset is one call - the same array drives both the runtime check and the phantom type:

```ts
const Receipt = defineProfile("receipt", [
  "sheet.worksheet", "cell.text", "cell.number", "attr.id",
] as const);
// Receipt: Profile<"sheet.worksheet" | "cell.text" | "cell.number" | "attr.id">
```

## Reading & writing directly

Each format exposes its profile, reader/writer factories, Context tags + Layers, and a `format` bundle for `convert()`:

```ts
import { text, bytes } from "@thomasfosterau/effect-document";
import * as Csv from "@thomasfosterau/effect-csv";
import * as Xlsx from "@thomasfosterau/effect-ooxml/xlsx";

// CSV text -> Doc<CsvFeature> (a single worksheet with inferred cell types)
const doc = yield* Csv.makeCsvReader().read(text("name,age\nalice,30\n"));

// Doc<SpreadsheetFeature> -> .xlsx bytes (multi-sheet, typed cells)
const xlsx = yield* Xlsx.makeXlsxWriter().write(spreadsheetDoc);
```

Streaming and synthetic data:

```ts
const rows = Csv.makeCsvReader().readStream!(text(bigCsv));   // Stream<readonly string[]>
// or scan text chunks as they arrive (fields, quotes and line breaks may span chunks)
const live = Csv.scanCsvStream(chunks, Csv.StandardDialect, { treatFirstRowAsHeader: true });
const synthetic = yield* Csv.synthesizeDocument({ columns: ["id", "email"], quantity: 10_000, seed: 42 });
```

## Packages

This repository is a monorepo of one core package and one package per format family.

| Package | Directory | Contents |
|---|---|---|
| `@thomasfosterau/effect-document` | `packages/core` | Schema, profiles, IO (`Reader`/`Writer`/`Format`, errors) and `convert` |
| `@thomasfosterau/effect-csv` | `packages/csv` | CSV/TSV reader, writer, streaming scanner and data synthesis |
| `@thomasfosterau/effect-ooxml` | `packages/ooxml` | `Xlsx`, `Docx` and `Pptx` namespaces over shared XML/OPC infrastructure |
| `@thomasfosterau/effect-rtf` | `packages/rtf` | RTF reader and writer |
| `@thomasfosterau/effect-pdf` | `packages/pdf` | PDF reader and writer, and the PDF object layer (`./cos`) |
| `@thomasfosterau/effect-iwork` | `packages/iwork` | `Pages`, `Numbers`, `Keynote` readers and the iWork container `Codec` |

Subpath exports:

| Import | Contents |
|---|---|
| `@thomasfosterau/effect-document/schema` | The document AST, attribute model, and feature taxonomy |
| `@thomasfosterau/effect-document/profile` | `Profile`/`Doc<F>`, conformance checking, `widen`/`narrow`, built-in `Profiles` |
| `@thomasfosterau/effect-document/profiles` | The built-in profiles (`Csv`, `Spreadsheet`, `Markdown`, …) as named exports |
| `@thomasfosterau/effect-document/io` | Content, Reader/Writer/Format, errors, `convert` |
| `@thomasfosterau/effect-ooxml/{xlsx,docx,pptx}` | A single OOXML format |
| `@thomasfosterau/effect-iwork/{pages,numbers,keynote,codec}` | A single iWork app, or the container codec |
| `@thomasfosterau/effect-pdf/cos` | The PDF object layer: parsing (with repair), filters, cross-reference tables and streams, writing |

## Format support

| Format | Read | Write | Notes |
|---|---|---|---|
| CSV / TSV | ✅ | ✅ | dialects, quoting, comments, streaming, type inference (CSV profile) |
| XLSX | ✅ | ✅ | multi-sheet, shared/inline strings, numbers, booleans, errors, formulas; dates round-trip as ISO strings; no styles yet |
| DOCX | ✅ | ✅ | headings, runs (bold/italic/underline/strike/super/sub/small-caps), hyperlinks, bullet/ordered lists, tables |
| PPTX | ✅ | ✅ | slides of text-box / placeholder shapes with paragraphs, headings and lists; no speaker notes / pictures yet |
| RTF | ✅ | ✅ | paragraphs and headings with bold/italic/underline/strike runs |
| PDF | ✅ | ✅ | reads structure back from the layout: headings, paragraphs, lists, code, bold/italic/code/links; writes with the standard 14 fonts (WinAnsi characters only); no encryption or OCR |
| Keynote (.key) | ⚠️ | 🔜 | **experimental**, read-only: extracts slide text from real `.key` files |
| Pages (.pages) | ⚠️ | 🔜 | **experimental**, read-only, best-effort: extracts body text |
| Numbers (.numbers) | ⚠️ | 🔜 | **experimental**, read-only: sheet structure only (cell values deferred) |
| JSON | ✅ | ✅ | via `Schema.encode`/`decode` of any `Document` |
| Markdown / HTML | 🔜 | 🔜 | schema + profiles modelled; readers/writers planned |

Apple iWork (`.pages`/`.numbers`/`.key`) are reverse-engineered binary bundles
(Protobuf in a non-standard Snappy variant). effect-document ships a
**dependency-free container codec** for them (`@thomasfosterau/effect-iwork/codec`:
IWA chunk framing, the Snappy block codec, a generic Protobuf wire reader, and the
zip-bundle opener), verified against real Apple files. The readers currently
extract *text* only and are experimental; writing requires the proprietary
object-graph schemas and is a future phase. Password-protected documents are
detected and refused.

Each format declares its own profile (`Csv`, `Spreadsheet`, `Docx`, `Pptx`, `Rtf`, `Pdf`), so converting between them widens for free or narrows with a report: e.g. `Docx → Rtf` down-converts links to text and drops lists/tables, while `Rtf → Docx` is a free widening.

PDF has no structure of its own to read - only glyphs at coordinates - so the
PDF reader infers it from the layout: the most common font size is body text,
larger sizes are heading levels, gaps wider than the usual leading separate
paragraphs, lines opening with a bullet or number are list items, and runs of
monospaced lines are code. Documents from typical producers (word processors,
browsers, report generators) come back with their headings,
paragraphs and inline styling; complex layouts (multiple columns, tables) come
back as text in content-stream order.

## Examples

```bash
bun run examples/convert-csv-to-xlsx.ts   # the headline conversion + loss reporting
bun run examples/document-ast.ts          # schema, JSON, profiles, narrowing
bun run examples/streaming.ts             # streaming rows + data synthesis
```

## Development

```bash
bun install        # install dependencies and link the workspace packages
bun test           # run every package's tests plus the cross-package tests in test/
bun run typecheck  # tsc --noEmit across all packages (also checks the compile-time profile guarantees)
bun run build      # bundle each package to its dist/
```

Each package's own tests live in `packages/<name>/test`; tests that span packages (cross-format conversion) live in `test/integration`. Run one package's tests with `bun test packages/<name>`.

Releases use [changesets](https://github.com/changesets/changesets): `bun run changeset` and pick the packages your change touches.

The type system is part of the test suite: `test/integration/type-level.ts` uses `@ts-expect-error` to assert that over-rich documents are rejected at compile time and that widening compiles.

## License

MIT
