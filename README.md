# effect-document

A **type-safe, profile-based universal document schema** for [Effect](https://effect.website) 4. One rich AST spans prose documents, spreadsheets and presentations; **profiles** carve out named subsets of it; and the type system tracks which subset every document belongs to, so a reader returns exactly the subset its format produces, a writer only accepts what its format can represent, and converting between formats tells you precisely what (if anything) was lost.

**Disclaimer:** this repository and its packages have been created using Claude Code. The API is in flux; expect churn and breaking changes.

```
                 ┌──────────────────────────────────────────────┐
   CSV  ───read──▶            universal document schema           ─write──▶  CSV
   XLSX ───read──▶  prose · spreadsheets · presentations + attrs  ─write──▶  XLSX
                 └──────────────────────────────────────────────┘
                     ▲  Csv ⊆ Spreadsheet ⊆ Full   (profiles)  ▲
                     └──── widen (free) ─── narrow (lossy) ─────┘
```

## Packages

The core package holds the schema, the profiles and the conversion pipeline; each format family is its own package, so you install only the formats you use.

| Package | What it is | Peers |
| --- | --- | --- |
| [`@thomasfosterau/effect-document`](packages/core/README.md) | The document schema (prose, spreadsheets, presentations, attributes), feature profiles with `widen` / `narrow` and loss reports, and the `Reader` / `Writer` / `Format` / `convert` pipeline. | `effect` |
| [`@thomasfosterau/effect-csv`](packages/csv/README.md) | CSV / TSV reader and writer: dialects, quoting, comments, type inference, chunked streaming, seeded synthetic data. | `effect` |
| [`@thomasfosterau/effect-ooxml`](packages/ooxml/README.md) | XLSX, DOCX and PPTX readers and writers on SpreadsheetML / WordprocessingML / PresentationML. | `effect` |
| [`@thomasfosterau/effect-rtf`](packages/rtf/README.md) | RTF reader and writer: paragraphs and headings with bold / italic / underline / strikeout runs. | `effect` |
| [`@thomasfosterau/effect-pdf`](packages/pdf/README.md) | PDF reader (structure recovered from the layout) and writer (standard 14 fonts), on a self-contained PDF object layer. | `effect` |
| [`@thomasfosterau/effect-iwork`](packages/iwork/README.md) | Experimental, read-only Keynote / Pages / Numbers readers and the iWork container codec. | `effect` |

## Install

```sh
pnpm add effect @thomasfosterau/effect-document @thomasfosterau/effect-csv @thomasfosterau/effect-ooxml
```

## Convert CSV to Excel and back

```ts
import * as Effect from "effect/Effect";
import { contentToText, convert, text } from "@thomasfosterau/effect-document";
import * as Csv from "@thomasfosterau/effect-csv";
import { Xlsx } from "@thomasfosterau/effect-ooxml";

const program = Effect.gen(function* () {
  // CSV ⊆ Spreadsheet: a free widening, nothing lost
  const { content: workbook } = yield* convert({
    from: Csv.format,
    to: Xlsx.format,
    input: text("product,price\nLaptop,999.99\nMouse,24.99\n"),
  });
  // Spreadsheet → CSV narrows: dates become ISO text, formulas their cached value,
  // extra sheets are dropped, and `loss.entries` says exactly what happened
  const { content, loss } = yield* convert({ from: Xlsx.format, to: Csv.format, input: workbook });
  return { csv: contentToText(content), lossless: loss.isLossless };
});
```

The type system is part of the contract: a writer for `Doc<CsvFeature>` will not compile against a document that may hold date cells until you `narrow` it, and widening a CSV document into a spreadsheet is ordinary assignability. The [core README](packages/core/README.md) explains the schema, profiles and pipeline; [`examples/`](examples) has runnable programs (`vp run examples`).

## Format support

| Format | Read | Write | Notes |
| --- | --- | --- | --- |
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

Each format declares its own profile (`Csv`, `Spreadsheet`, `Docx`, `Pptx`, `Rtf`, `Pdf`), so converting between them widens for free or narrows with a report: e.g. `Docx → Rtf` down-converts links to text and drops lists/tables, while `Rtf → Docx` is a free widening.

PDF has no structure of its own to read - only glyphs at coordinates - so the PDF reader infers it from the layout: the most common font size is body text, larger sizes are heading levels, gaps wider than the usual leading separate paragraphs, lines opening with a bullet or number are list items, and runs of monospaced lines are code. Documents from typical producers (word processors, browsers, report generators) come back with their headings, paragraphs and inline styling; complex layouts (multiple columns, tables) come back as text in content-stream order.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md). Repository conventions are in [AGENTS.md](AGENTS.md), the release pipeline in [PUBLISHING.md](PUBLISHING.md) and the vulnerability-reporting policy in [SECURITY.md](SECURITY.md).

## License

MIT — see [LICENSE](LICENSE).
