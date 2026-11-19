# Documents, profiles and conversion

## Documents

Every node is an Effect `Schema` class, so a whole document encodes to and decodes from plain JSON. The constructors build the common nodes:

```ts
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  Document,
  cell,
  document,
  header,
  para,
  str,
  strong,
  worksheet,
} from "@thomasfosterau/effect-document";

const report = document(
  [header(1, [str("Report")]), para([str("Sales were "), strong([str("up 12%")])])],
  { title: "Q2" },
);

// a spreadsheet is part of the same schema: a `Worksheet` block of typed cells
const sheet = document([
  worksheet("Sales", [[cell.text("North"), cell.number(42000)]], ["region", "revenue"]),
]);

const roundTrip = Effect.gen(function* () {
  const json = yield* Schema.encodeEffect(Document)(report);
  return yield* Schema.decodeUnknownEffect(Document)(json);
});
```

Effect's Schema parser recurses once per level of a document, so a document a few hundred levels deep overflows the call stack when encoded or decoded with `Schema`. `encodeDocument` and `decodeDocument` (and their `Result` forms, `encodeDocumentResult` / `decodeDocumentResult`) produce the same JSON and the same documents, and fail with the same `SchemaError`s, at any depth:

```ts
import { decodeDocument, encodeDocument } from "@thomasfosterau/effect-document";

const deepRoundTrip = Effect.gen(function* () {
  const json = yield* encodeDocument(report); // fails with a SchemaError
  return yield* decodeDocument(json);
});
```

The vocabulary is a Pandoc superset: the full inline and block set (emphasis, links, images, code, math, notes, lists, block quotes, figures, divs, tables), a spreadsheet model (`Worksheet` with typed `CellText` / `CellNumber` / `CellBoolean` / `CellDate` / `CellError` / `CellBlank` / `CellFormula` / `CellRichText`, merges and columns) (a worksheet holds only the rows it has, each row's cells by position, a plain number, string or boolean standing for its unstyled cell and `undefined` for a gap, and `denseRows` derives the grid, within a cell budget), and a presentation model (`SlideShow` → `Slide` → shapes and speaker notes). Most nodes carry an optional `attr`: an `id`, `classes`, a structured `style` and an open `data` map for format-specific attributes.

### Embedded resources

A document can carry binary resources (images, fonts, embedded files) in a media bag beside its blocks, as Pandoc's `MediaBag` does. A node refers to one with a `resource:<id>` URL where it would put any other URL (`Image.target.url`, `Picture.src`), so external URLs keep working. The bytes encode to JSON as base64. A document with resources uses the `doc.resources` feature: `Html`, `Presentation` and `Full` allow it, and `narrow` to any other profile drops each resource, reporting it at the path `["resources", id]` and leaving the `resource:` URLs as they are. To keep the files, take `doc.resources` before narrowing.

```ts
import {
  Image,
  Resource,
  document,
  imageInfo,
  para,
  str,
  withResource,
} from "@thomasfosterau/effect-document";

const logo = new Resource({ mediaType: "image/png", bytes: pngBytes, filename: "logo.png" });
const { document: withLogo, url } = withResource(document([]), logo); // the same bytes get the same URL
const doc = document(
  [para([new Image({ alt: [str("logo")], target: { url } })])],
  {},
  withLogo.resources,
);
imageInfo(pngBytes); // Option.some({ mediaType: "image/png", width, height, dpi })
```

## Profiles

A **feature** names one capability (`block.header`, `cell.date`, `attr.style`); a **profile** is a named set of them. A document is phantom-typed `Doc<F>` with the features it may use, and because the phantom is covariant, "is a subset of" is ordinary assignability: widening is free, and handing a writer a document that is too rich is a compile-time error.

```ts
import * as Effect from "effect/Effect";
import {
  Profiles,
  cell,
  defineProfile,
  document,
  narrow,
  worksheet,
} from "@thomasfosterau/effect-document";

const sheet = document([worksheet("S", [[cell.text("a"), cell.date(new Date(0))]])]);

Profiles.Csv.is(sheet); // false: CSV has no date cells

// narrow to a subset, learning exactly what was lost
const { document: csv, loss } = narrow(sheet, Profiles.Csv);
loss.entries;
// [{ feature: "cell.date", action: "converted", severity: "converted",
//    path: [0, "B1"], detail: "date cell converted to ISO text" }]
loss.summary; // the same, grouped: [{ feature: "cell.date", action: "converted", count: 1, paths: [[0, "B1"]], … }]

// validate instead, failing with the unsupported features
const checked = Profiles.Csv.validate(sheet); // Effect<Doc<CsvFeature>, ProfileViolation>

// your own subset: the same list drives the runtime check and the phantom type
const Receipt = defineProfile("receipt", ["sheet.worksheet", "cell.text", "cell.number"]);
```

A profile can also keep a feature it allows out of certain nodes, when the format can't tell the two apart there. RTF and PDF set headings in bold, so their profiles keep `Strong` out of headings: `is` and `validate` reject a document with `Strong` inside a `Header`, and `narrow` unwraps it with a loss entry giving the reason.

```ts
const BoldHeadings = defineProfile(
  "bold-headings",
  ["block.header", "inline.str", "inline.strong"],
  {
    notWithin: [{ feature: "inline.strong", within: "block.header", reason: "headings are bold" }],
  },
);
```

Two more kinds of rule say where a feature may appear and what a node's fields may hold. `onlyWithin` allows a feature only inside a given node, optionally one whose field holds one of a set of values; `fieldValues` restricts a node's own field. PPTX keeps a heading only as a slide's title, so its profile allows `block.header` only at level 1 and only in a title placeholder. Anywhere else, `is` and `validate` reject it, and `narrow` converts it to a paragraph with the rule's reason:

```ts
const Titles = defineProfile(
  "titles",
  ["deck.slideShow", "shape.placeholder", "block.header", "inline.str"],
  {
    onlyWithin: [
      {
        feature: "block.header",
        within: "shape.placeholder",
        where: { field: "placeholderType", oneOf: ["title", "ctrTitle"] },
        reason: "headings are slide titles",
      },
    ],
    fieldValues: [
      { feature: "block.header", field: "level", oneOf: [1], reason: "titles have one level" },
    ],
  },
);
```

A `whole` rule keeps a feature to the whole of a container's content. XLSX links a whole cell, never part of its text, so its profiles say a `Link` in a rich cell is the cell's only run. `is` and `validate` reject a link over part of a cell, and `narrow` widens it over the whole cell (keeping the first link's target), reporting a `converted` loss with the rule's reason. The container is a rich cell's runs (`within: "cell.richText"`):

```ts
const Cells = defineProfile(
  "cells",
  ["sheet.worksheet", "cell.richText", "inline.str", "inline.link"],
  {
    whole: [{ feature: "inline.link", within: "cell.richText", reason: "whole cells only" }],
  },
);
```

Profiles combine, at the type level and at run time alike. `unionProfiles` and `intersectProfiles` combine two profiles, `withoutFeatures` and `extendProfile` remove or add features, `isSubProfile(a, b)` (and the type `IsSubProfile<A, B>`) asks whether every document `a` accepts `b` accepts too, and `profileOf(doc)` is the smallest profile a document fits. Structural rules follow the operation: a union keeps only the rules both sides share, an intersection keeps every rule of either, and removing a feature drops the rules about it.

```ts
const DocxWithoutNotes = withoutFeatures("docx-no-notes", Docx, ["inline.note"] as const);
isSubProfile(profileOf(doc), Rtf); // can RTF hold this document losslessly?
```

The built-in profiles are `Csv`, `Spreadsheet`, `Markdown`, `Html`, `Presentation` and `Full` (on `Profiles`, or as named exports from `./profiles`); each format package adds its own (`Docx`, `Pptx`, `Rtf`, `Pdf`, …).

## Reading, writing and converting

A `Reader<F>` parses `Content` (text or bytes) into a `Doc<F>`; a `Writer<F>` renders one back; a `Format<F>` bundles a reader and/or writer with their profile. `convert` wires one format's reader to another's writer, widening for free or narrowing when the target is poorer, and returns the loss report with the output:

```ts
import * as Effect from "effect/Effect";
import { contentToBytes, convert, text } from "@thomasfosterau/effect-document";
import * as Csv from "@thomasfosterau/effect-document/csv";
import { Xlsx } from "@thomasfosterau/effect-document/ooxml";

const program = Effect.gen(function* () {
  // CSV ⊆ Spreadsheet, so this direction loses nothing
  const { content, loss } = yield* convert({
    from: Csv.format,
    to: Xlsx.format,
    input: text("product,price\nLaptop,999.99\n"),
  });
  return { workbook: contentToBytes(content), lossless: loss.isLossless };
});
```

Each loss entry says where it was (`path`: block indexes from the document's top, then a list item, slide, shape or table row index, a part such as `"notes"`, or a worksheet cell's A1 address) and how bad it is (`severity`: `dropped-content`, `dropped-formatting` or `converted`); `summary` groups the entries by feature, so 10,000 date cells are one item with a count. `LossReport` is a `Schema`, so a report encodes to JSON for logs and CLI output. `convert` takes `onLoss`: `"allow"` (the default), `"warn"` (logs a warning per summary item with `Effect.logWarning`, annotated with the formats, feature and count) or `"fail"` (writes nothing and fails with a `ConversionError` whose `loss` is the report).

Readers and writers report what they meet along the way as **diagnostics**: a `Diagnostic` has the `format`, the `stage` (`read` or `write`), a stable `code` (`xlsx.nonFiniteNumber` for a `NaN` written as `#NUM!`, `xlsx.sheetRenamed` for a sheet name Excel refuses, `iwork.componentSkipped` for a component a lenient iWork read skipped, `iwork.unknownFormatVersion` for an iWork document from a version the reader has not been checked against), a `severity` (a loss severity; or, when nothing was lost, `repaired` for malformed input read anyway, or `notice` for something worth knowing), a `path` and a `detail`. Each is a warning log record annotated with the diagnostic (`logDiagnostic`, under `DIAGNOSTIC_ANNOTATION`), so no signature changes: `convert` gathers them into `loss.diagnostics`, and any diagnostic but a `repaired` or `notice` one (`losesNothing`) makes the report lossy and fails `onLoss: "fail"` (one from the writer is known only once it has run, but no content is returned). A direct `reader.read` or `writer.write` call shows them through the app's loggers; `collectDiagnostics(effect)` returns them beside the result. A `MinimumLogLevel` above `Warn` filters them out before any logger, `convert`'s included.

Failures are tagged errors in the error channel: `ParseError` (with the format, a `code` saying what kind of failure it is, and where known a source position), `WriteError`, `ProfileViolation` and `ConversionError` (a format with no reader or writer, or a loss under `onLoss: "fail"`). Every reader and writer is also available as a Context tag with a default `Layer` (`CsvReaderTag` / `CsvReaderLive`, …) for programs that inject them. A `ParseError`'s `code` is the same across readers: `InvalidContainer` (not a zip), `WrongFormat` (another format's file), `MissingPart`, `Encrypted`, `MalformedXml`, `MalformedBinary`, `MalformedText`, `LimitExceeded` (a configured limit, not malformed input) or `Unsupported`; its `position` can name a package `part`, a byte `offset`, an iWork `component` and `object`, or a `sheet` and `cell`, besides `row` and `column`.

## Detecting a format and finding its tables

For a file of unknown type, `detect` asks each format you pass which of them the content is, and ranks the answers. Each format's own sniffer looks at the bytes, never the name. A file name or MIME type in `hints` only breaks ties, so a `.csv` that is really a workbook comes back as XLSX. Each candidate carries a `confidence` (0 to 1) and an `evidence` string a UI can show. A sniffer stays within its reader's zip limits, and `detect` never fails.

```ts
import { bytes, candidateTables, detect } from "@thomasfosterau/effect-document";
import * as Csv from "@thomasfosterau/effect-document/csv";
import { Docx, Pptx, Xlsx } from "@thomasfosterau/effect-document/ooxml";
import * as Pdf from "@thomasfosterau/effect-document/pdf";

const program = Effect.gen(function* () {
  const [best] = yield* detect(bytes(data), {
    formats: [Csv.format, Csv.tsvFormat, Xlsx.format, Docx.format, Pptx.format, Pdf.format],
    hints: { fileName: "upload.xlsx" },
  });
  // best?.format.id === "xlsx", best?.evidence: "ZIP with xl/workbook.xml (SpreadsheetML main part); extension .xlsx"
  const doc = yield* best!.format.reader!.read(bytes(data));
  return candidateTables(doc); // every worksheet and prose table, with a locator, its size and a header guess
});
```

`candidateTables` lists every `Worksheet` and every prose `Table`, wherever it sits: in a `Div`, a `Figure`, a list item, another table's cell, or a slide's table shape. Each region gets a `locator` (the path shape of a loss entry), a name or caption, its size and a header guess. A prose table also comes flattened to a text grid, with its merged cells placed and listed in `spans`.

For text whose separator isn't known, `Csv.sniffDialect(text)` reads the first 64 KiB and returns `CsvReaderOptions` for it: the separator (comma, semicolon, tab or pipe), the line break, how many preamble lines to skip, and whether the first row is a header (the reader's own rule). It also gives a confidence and an evidence string. A line the sample cuts off isn't judged, so the options it returns read the whole file as they read the sample.

For bytes whose text encoding isn't known, `detectEncoding` (from `/encoding`) looks at the first 64 KiB. A byte-order mark settles it; otherwise UTF-16 is told by its zero bytes, then UTF-8 if the sample is valid UTF-8, and Windows-1252 if it is not. The guess comes with a `confidence` and an `evidence` string ("not valid UTF-8 at byte 312; read as Windows-1252") for a UI to show and the user to override. `decodeText(content, { encoding })` then decodes with that encoding, or the detected one, strictly: a byte the encoding doesn't define fails with a `ParseError` (code `MalformedText`, at its byte offset) rather than becoming U+FFFD. Hand the `Text` it gives to any text reader. `contentToText` and the readers still decode bytes as UTF-8; this is the opt-in path.

```ts
import { bytes } from "@thomasfosterau/effect-document";
import { decodeText, detectEncoding } from "@thomasfosterau/effect-document/encoding";
import * as Csv from "@thomasfosterau/effect-document/csv";

const program = Effect.gen(function* () {
  const guess = yield* detectEncoding(bytes(data)); // { encoding: "windows-1252", confidence: 0.5, evidence: "…", bom: false }
  const input = yield* decodeText(bytes(data), { encoding: guess.encoding });
  return yield* Csv.makeCsvReader().read(input);
});
```

For a preview of a large file, pass `maxRows`: the CSV reader then reads at most that many records after `skipRows` (a header row counts as one) and never looks at the rest of the input. The XLSX reader keeps at most that many rows of each sheet. A document cut short says so in `meta.truncated` (`{ maxRows, sheets }`): `isTruncated(doc)` and `truncationOf(doc)` read it, so a preview never passes for the whole file.
