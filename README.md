# effect-document

A **type-safe, profile-based universal document schema** built on [Effect](https://effect.website). One rich AST spans prose documents, spreadsheets, and presentations; **profiles** carve out named subsets of that schema; and the type system tracks which subset every document belongs to - so a reader returns exactly the subset its format produces, a writer only accepts what its format can represent, and converting between subsets tells you precisely what (if anything) was lost.

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

```bash
bun add @thomasfosterau/effect-document effect
```

`effect` is a peer dependency; `fflate` (for XLSX) is bundled.

## Quick start: convert CSV to Excel

```ts
import { Effect } from "effect";
import { contentToBytes, convert, text, Csv, Xlsx } from "@thomasfosterau/effect-document";

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
import { text, bytes, Csv, Xlsx } from "@thomasfosterau/effect-document";

// CSV text -> Doc<CsvFeature> (a single worksheet with inferred cell types)
const doc = yield* Csv.makeCsvReader().read(text("name,age\nalice,30\n"));

// Doc<SpreadsheetFeature> -> .xlsx bytes (multi-sheet, typed cells)
const xlsx = yield* Xlsx.makeXlsxWriter().write(spreadsheetDoc);
```

Streaming and synthetic data:

```ts
const rows = Csv.makeCsvReader().readStream!(text(bigCsv));   // Stream<readonly string[]>
const synthetic = yield* Csv.synthesizeDocument({ columns: ["id", "email"], quantity: 10_000, seed: 42 });
```

## Package layout

| Import | Contents |
|---|---|
| `@thomasfosterau/effect-document` | Everything: schema, profiles, IO, and the `Csv`/`Xlsx` namespaces |
| `.../schema` | The document AST, attribute model, and feature taxonomy |
| `.../profile` | `Profile`/`Doc<F>`, conformance checking, `widen`/`narrow`, built-in `Profiles` |
| `.../csv`, `.../xlsx` | The format readers/writers (same as the `Csv`/`Xlsx` namespaces) |

## Format support

| Format | Read | Write | Notes |
|---|---|---|---|
| CSV / TSV | ✅ | ✅ | dialects, quoting, comments, streaming, type inference (CSV profile) |
| XLSX | ✅ | ✅ | multi-sheet, shared/inline strings, numbers, booleans, errors; dates round-trip as ISO strings; no styles/formulas yet |
| JSON | ✅ | ✅ | via `Schema.encode`/`decode` of any `Document` |
| Markdown / HTML / docx / PPTX | 🔜 | 🔜 | schema + profiles modelled; readers/writers planned |

## Examples

```bash
bun run examples/convert-csv-to-xlsx.ts   # the headline conversion + loss reporting
bun run examples/document-ast.ts          # schema, JSON, profiles, narrowing
bun run examples/streaming.ts             # streaming rows + data synthesis
```

## Development

```bash
bun install        # install dependencies
bun test           # run the test suite
bun run typecheck  # tsc --noEmit (also checks the compile-time profile guarantees)
bun run build      # bundle to dist/
```

The type system is part of the test suite: `test/type-level.ts` uses `@ts-expect-error` to assert that over-rich documents are rejected at compile time and that widening compiles.

## License

MIT
