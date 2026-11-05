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

## Performance

`vp run bench` measures every reader and writer against the leading JavaScript library for its format (`bench/`). Medians from runs on a 4-core cloud VM with Node 22, each case timed on its own; each figure is the other library's time divided by ours, so above 1× means we are faster:

| Task | Input | Compared with |
| --- | --- | --- |
| CSV scan (text → string rows) | 8 MB, 100k mixed rows | uDSV 0.87×, Papa Parse 1.03×, d3-dsv 1.04×, csv-parse 3.5× |
| CSV scan, every field quoted / all numbers / full-precision floats | 2.7 MB / 4.2 MB / 5 MB | uDSV 0.94× / 0.85× / 0.76×, d3-dsv 1.31× / 1.15× / 1.24×, Papa Parse 2.3× / 2.3× / 2.2× |
| CSV typed rows (`readCsvRows`: text → rows of values) | 8 MB mixed | uDSV (inferring its schema) 1.14×, Papa Parse `dynamicTyping` 2.1×, d3-dsv `autoType` 2.5× |
| CSV typed rows, quoted / numbers / floats | 2.7 MB / 4.2 MB / 5 MB | uDSV 0.94× / 1.04× / 0.98×, d3-dsv 1.96× / 2.2× / 1.54×, Papa Parse 3.9× / 3.5× / 3.1× |
| CSV read (text → typed document) | 8 MB mixed / 80 KB | uDSV 0.86× / 1.09×, Papa Parse 1.61× / 2.9×, d3-dsv 1.87× / 3.6× |
| CSV read, quoted / numbers / floats | 2.7 MB / 4.2 MB / 5 MB | uDSV 0.88× / 0.91–0.98× / 0.5–0.9×, d3-dsv 1.83× / 1.40× / 1.04×, Papa Parse 3.6× / 3.0× / 3.1× |
| CSV stream (64 KiB chunks) | 8 MB mixed | Papa Parse's Node stream 2.2×, csv-parse's 2.6× |
| CSV write | 8 MB mixed / 2.7 MB quoted | from a document: Papa Parse (from rows) 1.73× / 1.55×; `renderTable` (from rows): d3-dsv 1.07× / 1.30× |
| XLSX read / write | 160k cells / 4k cells | read: SheetJS 1.21× / 0.95×, ExcelJS 1.39× / 1.39× (the document 7.5 MB against SheetJS's 19 MB); write: SheetJS 1.31×, ExcelJS 2.0× |
| DOCX read / write | 500 sections | mammoth `extractRawText` 1.88× / `docx` 0.79× (it writes no lists or tables) |
| PPTX write | 200 slides | PptxGenJS 1.35× |
| PDF read / write | 200 sections | pdf.js text extraction 1.01× / pdf-lib 1.23× |
| CSV → XLSX / XLSX → CSV | 20k rows | SheetJS 1.23× / 0.87× |

`readCsvRows` returns what the CSV libraries return, rows of plain values, with `read`'s header handling and type inference; `read` builds a document. A row's cells are positional and a plain number, string or boolean is its bare value (#226), so a document of plain values holds about what the libraries' arrays do (a row of numbers is an array of unboxed doubles: `readCsvRows` holds 10.5 MB for the numbers table, as uDSV does, and `read` 15.3 MB with its row nodes) and `read` costs little more than `readCsvRows`. The libraries keep a number whatever its digits; both of our readers keep a number only when its double holds the digits it is written with (`12345678901234567890` stays text). Medians on this VM vary by up to ±40% between runs, so the typed-rows numbers and floats figures come from comparisons run in one process with 40 or more rounds a case; the order of the libraries does not change between runs.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md). Repository conventions are in [AGENTS.md](AGENTS.md), the release pipeline in [PUBLISHING.md](PUBLISHING.md) and the vulnerability-reporting policy in [SECURITY.md](SECURITY.md).

## License

MIT — see [LICENSE](LICENSE).
