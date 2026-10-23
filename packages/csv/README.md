# @thomasfosterau/effect-csv

CSV and TSV for [`@thomasfosterau/effect-document`](https://www.npmjs.com/package/@thomasfosterau/effect-document): a reader and writer for the `Csv` profile (one worksheet of text, number, boolean and blank cells), dialects, quoting, comments, type inference, a chunked streaming scanner, and seeded synthetic data. Parsing is built on [`@thomasfosterau/effect-parse`](https://www.npmjs.com/package/@thomasfosterau/effect-parse).

> **Experimental.** The API is in flux; expect breaking changes before 1.0.

## Install

```sh
pnpm add effect @thomasfosterau/effect-document @thomasfosterau/effect-csv
```

## Reading and writing

```ts
import * as Effect from "effect/Effect";
import { contentToText, text } from "@thomasfosterau/effect-document";
import * as Csv from "@thomasfosterau/effect-csv";

const program = Effect.gen(function* () {
  // a single worksheet: the header row is sniffed, and the age and admin
  // columns are inferred as number and boolean cells
  const doc = yield* Csv.makeCsvReader().read(text("name,age,admin\nalice,30,true\n"));
  const out = yield* Csv.makeCsvWriter().write(doc);
  return contentToText(out); // "name,age,admin\nalice,30,true\n"
});
```

By default the reader sniffs the header row: the first row is the header when every value in it is text and some column below it is all numbers or booleans. Pass `treatFirstRowAsHeader: true` or `false` to decide instead (an all-text file needs `true` for its first row to be a header). Each column is typed as a whole: a column is numeric only if every value in it is a number, so a code such as `007` keeps its whole column as written. Pass `inference: "cell"` to type each value on its own instead. Only plain decimals whose digits a double holds exactly become numbers, so 20-digit IDs stay text.

`Csv.format` and `Csv.tsvFormat` are the bundles for `convert`; `Csv.makeFormat({ reader, writer })` builds one with options. Pass `inferTypes: false` to keep every value a text cell exactly as written, a `dialect` (`StandardDialect`, `TsvDialect` or your own `CsvDialect`) for other separators and quoting, and `skipRows`, `lineCommentMarker`, `trimWhitespace` or `filterEmpty` to clean messy input. A malformed file (an unterminated quote, a ragged row under a header) fails with a `ParseError` carrying its position in the source.

The writer quotes only the fields that need it (`quoting: "minimal"`); `quoting` also takes `"all"`, `"nonNumeric"` and `"none"`, after Python's `csv.QUOTE_*`. It doubles a wrapper inside a quoted field, as RFC 4180 specifies, or escapes it with `escapeChar` (`"\\"`, say) instead; a field holding the escape character itself fails the write, and the reader has no escape-character option yet. Rows end with the dialect's `linebreak`: LF in `StandardDialect`, CRLF in `Rfc4180Dialect`. Set `bom: true` for Excel to detect UTF-8, `headers` to write a header row first, and `padRows` to pad short rows into a rectangle. Numbers are written as shortest round-trip decimals with no exponent form (`formatNumber` overrides it). `renderCsvStream` renders a `Stream` of rows one chunk per row.

**Formula injection.** Spreadsheet apps run a cell that starts with `=`, `+`, `-` or `@` as a formula when the file is opened, so a value such as `=HYPERLINK(...)` from untrusted input can act on whoever opens the file. Set `escapeFormulae: true` when writing such data for people to open: it prefixes `'` to text fields that start with one of those characters, a tab or a CR, and quotes them. It changes the values, so leave it off for files that programs read.

## Streaming

`readStream` yields rows without building the document, and `scanCsvStream` scans text that arrives in chunks; a field, a quoted line break or a CRLF may span chunk boundaries:

```ts
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Csv from "@thomasfosterau/effect-csv";

const chunks = Stream.make("id,na", "me\n1,a", "lice\n2,bob\n");
const rows = Csv.scanCsvStream(chunks, Csv.StandardDialect, { treatFirstRowAsHeader: true });
const all = Stream.runCollect(rows); // [["1", "alice"], ["2", "bob"]]
```

## Synthetic data

```ts
import * as Csv from "@thomasfosterau/effect-csv";

// the same seed always gives the same table
const doc = Csv.synthesizeDocument({ columns: ["id", "email"], quantity: 1_000, seed: 42 });
```

## API reference

### `@thomasfosterau/effect-csv`

| Export | Kind | Description |
| --- | --- | --- |
| `profile` | const | The CSV profile. |
| `CsvFormatOptions` | interface | Options for the CSV format bundle. |
| `makeFormat` | function | Create a CSV Format bundle with custom reader/writer options. |
| `format` | const | The CSV format bundle with default options, for use with `convert`. |
| `tsvFormat` | const | The TSV (tab-separated values) format bundle. |
| `CsvDialect` | interface | CSV dialect configuration - format variations like separators and quoting. |
| `StandardDialect` | const | Standard comma-separated values, written with LF line breaks |
| `Rfc4180Dialect` | const | Comma-separated values written with the CRLF line breaks RFC 4180 specifies |
| `TsvDialect` | const | Tab-separated values |
| `CsvScanOptions` | interface | How the scanner splits CSV text into rows. |
| `ScannedTable` | interface | The result of scanning CSV text. |
| `scanCsv` | function | Scan CSV text into headers and raw string rows. |
| `scanCsvStream` | function | Scan a stream of CSV text chunks into data rows, emitting each row as soon as it is complete. |
| `CsvFeature` | type | The features the CSV profile allows, as a type. |
| `CsvInferenceOptions` | interface | How raw strings become typed values. |
| `CsvReaderOptions` | interface | Options for the CSV reader. |
| `inferCell` | function | Infer a typed cell from a raw CSV string value, on its own. |
| `makeCsvReader` | function | Create a CSV Reader with the given options baked in. |
| `CsvReaderTag` | const | Context tag for dependency-injection style usage. |
| `CsvReaderLive` | const | Layer providing a CSV Reader with default options. |
| `makeCsvReaderLayer` | function | Layer providing a CSV Reader with custom options. |
| `CsvQuoting` | type | When to quote fields, after Python's `csv.QUOTE_*`. |
| `CsvWriterOptions` | interface | Options for the CSV writer. |
| `formatCsvNumber` | function | Render a number as its shortest round-trip decimal, never in exponent form. |
| `renderField` | function | Render a single field, quoting it if necessary (as the `minimal` mode does). |
| `renderTable` | function | Render rows of string fields to CSV text (with trailing newline). |
| `renderCsvStream` | function | Render a stream of worksheet rows to CSV text, one chunk per row (the BOM and header row, if any, come first). |
| `makeCsvWriter` | function | Create a CSV Writer with the given options baked in. |
| `CsvWriterTag` | const | Context tag for dependency-injection style usage. |
| `CsvWriterLive` | const | Layer providing a CSV Writer with default options. |
| `makeCsvWriterLayer` | function | Layer providing a CSV Writer with custom options. |
| `SynthesisSpec` | interface | What to synthesize. |
| `SynthesizedTable` | interface | The raw result of synthesis. |
| `synthesizeTable` | function | Generate a table of random string data according to the spec. |
| `synthesizeDocument` | function | Generate a single-worksheet CSV-profile document of random string data. |
