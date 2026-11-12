# @thomasfosterau/effect-document

A type-safe, profile-based universal document schema for [Effect](https://effect.website) 4. One Pandoc-style AST spans prose documents, spreadsheets and presentations; **profiles** carve out named subsets of it; and the type system tracks which subset a document belongs to, so a reader returns exactly what its format produces, a writer accepts only what its format can represent, and converting between formats reports precisely what was lost.

This package holds the schema, the profiles and the `Reader` / `Writer` / `Format` / `convert` pipeline on its root entry, and every file format on a subpath of its own: [`/csv`](#csv-and-tsv-csv), [`/ooxml`](#office-open-xml-ooxml) (XLSX, DOCX, PPTX), [`/rtf`](#rtf-rtf), [`/pdf`](#pdf-pdf) and [`/iwork`](#apple-iwork-iwork). No format is on the root barrel, so importing the root loads none of them.

> **Experimental.** The API is in flux; expect breaking changes before 1.0.

## Install

```sh
pnpm add effect @thomasfosterau/effect-document
# for /csv, /rtf, /ooxml or /iwork:
pnpm add @thomasfosterau/effect-parse
```

`effect` (`^4.0.0`) is a peer dependency: your application owns the single copy. `@thomasfosterau/effect-parse` (`^0.4.1`) is an optional peer, needed only by the formats written on it (see [Formats](#formats)).

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
loss.entries; // [{ feature: "cell.date", action: "converted", detail: "date cell converted to ISO text" }]

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

Failures are tagged errors in the error channel: `ParseError` (with the format, a `code` saying what kind of failure it is, and where known a source position), `WriteError`, `ProfileViolation` and `ConversionError` (a format with no reader or writer). Every reader and writer is also available as a Context tag with a default `Layer` (`CsvReaderTag` / `CsvReaderLive`, …) for programs that inject them. A `ParseError`'s `code` is the same across readers: `InvalidContainer` (not a zip), `WrongFormat` (another format's file), `MissingPart`, `Encrypted`, `MalformedXml`, `MalformedBinary`, `MalformedText`, `LimitExceeded` (a configured limit, not malformed input) or `Unsupported`; its `position` can name a package `part`, a byte `offset`, an iWork `component` and `object`, or a `sheet` and `cell`, besides `row` and `column`.

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

For a preview of a large file, pass `maxRows`: the CSV reader then reads at most that many records after `skipRows` (a header row counts as one) and never looks at the rest of the input. The XLSX reader keeps at most that many rows of each sheet. A document cut short says so in `meta.truncated` (`{ maxRows, sheets }`): `isTruncated(doc)` and `truncationOf(doc)` read it, so a preview never passes for the whole file.

## API reference

The root entry re-exports everything; the subpaths expose one area each.

### `@thomasfosterau/effect-document/schema`

| Export | Kind | Description |
| --- | --- | --- |
| `InlineFeature` | type | Inline-level node features (prose). |
| `BlockFeature` | type | Block-level node features (prose). |
| `SheetFeature` | type | Spreadsheet features (the `Worksheet` block and its typed cells). |
| `DeckFeature` | type | Presentation features (the `SlideShow` block, its slides and shapes). |
| `AttrFeature` | type | Cross-cutting attribute-facet features (which kinds of `Attributes` are allowed). |
| `IdFeature` | type | Per-node id facets (`attr.id.header`, `attr.id.link`, …): an id allowed on one kind of node only. |
| `ID_FEATURE` | const | Each node's id facet, keyed by its tag (`TableCell` and `Slide` for the untagged ones). |
| `IdNode` | type | A node tag `ID_FEATURE` keys. |
| `idFeatureOf` | function | The id facet of a node with the given tag. |
| `WithIdFeatures` | type | A feature set with `attr.id` standing for every `IdFeature`, as `defineProfile` reads it. |
| `withIdFeatures` | function | A feature list with `attr.id` expanded to every per-node id facet. |
| `Feature` | type | Any capability the universal document schema can express. |
| `TAG_FEATURE` | const | Maps a node's `_tag` to the feature it represents. |
| `TaggedNode` | type | Any document node whose tag `TAG_FEATURE` maps to a feature. |
| `featureOfTag` | function | The feature represented by a node's tag, if the tag is mapped. |
| `ALL_INLINE_FEATURES` | const | Every inline feature, for assembling profiles. |
| `ALL_BLOCK_FEATURES` | const | Every prose block feature, for assembling profiles. |
| `ALL_SHEET_FEATURES` | const | Every spreadsheet feature (worksheets and cell types), for assembling profiles. |
| `ALL_DECK_FEATURES` | const | Every presentation feature (slide shows and shapes), for assembling profiles. |
| `ALL_ATTR_FEATURES` | const | Every attribute facet feature, for assembling profiles. |
| `ALL_ID_FEATURES` | const | Every per-node id facet. |
| `ALL_FEATURES` | const | Every feature in the schema - the maximal ("Full") profile's allow-set. |
| `AttrValue` | const | A JSON-compatible value usable as a custom attribute. |
| `HorizontalAlign` | const | Horizontal alignment of text in a paragraph or cell. |
| `VerticalAlign` | const | Vertical alignment of content in a cell. |
| `FontProps` | const | Character-level font properties. |
| `Style` | const | Structured visual styling. |
| `Attributes` | const | The attribute bundle carried by document nodes. |
| `attrField` | const | An optional `attr` field for a node schema. |
| `noAttr` | const | The empty attribute bundle. |
| `AttrPolicy` | interface | Declares which attribute facets a profile permits. |
| `usedAttrFeatures` | function | The attribute facets actually populated on an `Attributes` value. |
| `policyFeatures` | function | The attribute facets a policy permits, as features. |
| `Str` | class | A run of literal text. |
| `Space` | class | Inter-word space. |
| `SoftBreak` | class | A soft line break (a newline that may be re-wrapped). |
| `LineBreak` | class | A hard line break. |
| `Emph` | class | Emphasized (italic) content. |
| `Strong` | class | Strongly emphasized (bold) content. |
| `Underline` | class | Underlined content. |
| `Strikeout` | class | Struck-out content. |
| `Superscript` | class | Superscripted content. |
| `Subscript` | class | Subscripted content. |
| `SmallCaps` | class | Small-caps content. |
| `QuoteType` | const | Which quotation marks a `Quoted` inline uses. |
| `Quoted` | class | Quoted content (rendered with locale-appropriate quotation marks). |
| `CitationMode` | const | How a citation renders. |
| `Citation` | class | A single citation within a `Cite`. |
| `Cite` | class | A citation cluster. |
| `Code` | class | Inline code span. |
| `MathType` | const | Whether a `Math` inline is set inline or as display math. |
| `Math` | class | Inline or display math (TeX). |
| `RawInline` | class | Raw inline content in a named target format (e.g. |
| `Target` | const | A link target. |
| `Link` | class | A hyperlink. |
| `Image` | class | An image; `alt` is its alternate-text inlines. |
| `Note` | class | A footnote/endnote, containing block content. |
| `Span` | class | A generic inline container carrying attributes. |
| `Inline` | const | Any inline-level node. |
| `Plain` | class | Inline content without paragraph semantics (used in tight contexts). |
| `Para` | class | A paragraph. |
| `LineBlock` | class | Lines whose breaks are significant (verse, addresses). |
| `CodeBlock` | class | A block of preformatted code. |
| `RawBlock` | class | Raw block content in a named target format. |
| `BlockQuote` | class | A block quotation. |
| `ListNumberStyle` | const | The numbering style of an ordered list (Pandoc `ListNumberStyle`). |
| `ListNumberDelim` | const | The punctuation after an ordered list number (Pandoc `ListNumberDelim`). |
| `OrderedList` | class | An ordered (numbered) list; each item is a sequence of blocks. |
| `BulletList` | class | A bullet (unordered) list. |
| `DefinitionItem` | class | A term-with-definitions entry in a definition list. |
| `DefinitionList` | class | A definition list. |
| `Header` | class | A section heading (level 1-6). |
| `HorizontalRule` | class | A horizontal rule / thematic break. |
| `Figure` | class | A figure. |
| `Div` | class | A generic block container carrying attributes. |
| `ColWidth` | const | A table column width as a fraction of the text width, or `null` for the default. |
| `ColSpec` | class | A column specification. |
| `TableCell` | class | A prose table cell, holding block content (Pandoc style). |
| `TableRow` | class | A row of prose-table cells. |
| `Table` | class | A prose table. |
| `CellText` | class | A text cell. |
| `CellNumber` | class | A numeric cell. |
| `CellBoolean` | class | A boolean cell. |
| `CellDate` | class | A date/time cell (a genuine date value, distinct from a number). |
| `CellError` | class | An error cell (carries the error literal, e.g. |
| `CellBlank` | class | An empty cell. |
| `CellFormula` | class | A formula cell. |
| `CellRichText` | class | A rich-text cell with character-level formatting (inline runs). |
| `SheetCell` | const | Any typed spreadsheet cell. |
| `SheetColumn` | class | A column definition (width / default style). |
| `PlainCell` | const | A finite number, string or boolean standing in a row for its unstyled cell node. |
| `RowCell` | const | One position of a row: its cell (a node or a plain cell), or `undefined` for a gap (`null` in JSON). |
| `SheetRow` | class | A spreadsheet row: its 0-based `index` and its cells by position (`undefined` a gap, the last a cell). |
| `PlainRow` | schema | A row's cells alone, standing in a worksheet's `rows` for the row one past the one before it, with no height (#227); a bare array in JSON. |
| `isPlainRow` | function | Whether a worksheet row is a plain row rather than a `SheetRow`. |
| `MergeRange` | class | A rectangular merged-cell range (0-based, inclusive). |
| `Worksheet` | class | A spreadsheet worksheet: a named, sparse grid of typed cells. |
| `TextBox` | class | A text box shape. |
| `Picture` | class | A picture shape. |
| `TableShape` | class | A table shape (wraps a prose `Table`). |
| `Placeholder` | class | A layout placeholder shape (title, body, ...). |
| `Shape` | const | Any slide shape. |
| `Slide` | class | A single slide. |
| `SlideSize` | class | Deck-level geometry (EMU or px, by convention of the producing format). |
| `SlideShow` | class | A presentation deck. |
| `Block` | const | Any block-level node (prose, spreadsheet, or presentation). |
| `Meta` | const | Document metadata (title, author, arbitrary key/values). |
| `Document` | class | A complete document. |
| `str` | function | A `Str`. |
| `emph` | function | An `Emph` (emphasis, usually italic) around `content`. |
| `strong` | function | A `Strong` (strong emphasis, usually bold) around `content`. |
| `link` | function | A `Link` to `url` (with an optional `title`) around `content`. |
| `para` | function | A `Para`. |
| `plain` | function | A `Plain` block. |
| `plainText` | function | A `Plain` block holding a single `Str` of `text`. |
| `header` | function | A `Header` of `level` 1–6 around `content`. |
| `codeBlock` | function | A `CodeBlock` of verbatim `text`, optionally tagged with its `language`. |
| `bulletList` | function | A `BulletList`; each item is a sequence of blocks. |
| `orderedList` | function | An `OrderedList` with default numbering; each item is a sequence of blocks. |
| `table` | function | A prose table from header strings and a grid of block-cell content. |
| `cell` | const | Ergonomic spreadsheet-cell constructors. |
| `worksheet` | function | A worksheet from optional header strings and a grid of cells. |
| `textBox` | function | A `TextBox` shape holding prose blocks. |
| `slide` | function | A `Slide` of `shapes`, with optional speaker `notes`. |
| `slideShow` | function | A `SlideShow` block. |
| `document` | function | Construct a document from blocks (with optional metadata). |
| `space` / `softBreak` / `lineBreak` | function | A `Space`, `SoftBreak` or `LineBreak`. |
| `underline` / `strikeout` / `superscript` / `subscript` / `smallCaps` | function | The formatting inlines around content. |
| `quoted` / `code` / `math` / `rawInline` | function | `Quoted` content (double quotes by default), inline `Code` (optional attributes), TeX `Math` (inline by default) and a format's verbatim `RawInline`. |
| `image` / `note` / `span` | function | An `Image` (alt inlines, optional title), a `Note` of blocks and a `Span` of inlines with attributes. |
| `blockQuote` / `div` / `figure` / `definitionList` / `lineBlock` / `horizontalRule` / `rawBlock` | function | The remaining prose blocks. |
| `picture` / `placeholder` | function | A `Picture` shape and a `Placeholder` shape. |
| `textInlines` | function | A string as `Str` / `Space` / `SoftBreak` inlines, as Pandoc's `text` builder splits it. |
| `normalizeInlines` | function | Inlines with adjacent `Str`s merged, empty ones dropped and whitespace runs collapsed (shallow). |
| `inlinesToText` | function | Collapse a sequence of inlines to plain text. |
| `cellToText` | function | Collapse a single spreadsheet cell to plain text. |
| `shapeToText` | function | Collapse a single slide shape to plain text. |
| `blocksToText` | function | Collapse a sequence of blocks to plain text (one line per block). |
| `SheetExtent` | interface | A worksheet's extent: one past its last row index and one past its last column. |
| `sheetExtent` | function | The extent of a worksheet. |
| `DEFAULT_MAX_DENSE_CELLS` | const | The default `DenseRowsOptions.maxCells`: five million cells. |
| `DenseGridTooLarge` | class | A worksheet's dense grid would be larger than the budget it was asked for under. |
| `DenseRowsOptions` | interface | Options for `denseRows` and `denseSize`. |
| `denseSize` | function | The cells `denseRows` would allocate for a worksheet, plus one per row. |
| `denseRows` | function | The derived dense view of a worksheet, built only within a cell budget. |
| `sheetRow` | function | A row from its cells by position (`undefined` a gap), the array copied. |
| `worksheetFromRows` | function | A worksheet of finished rows, for readers that build each row as they go (`sheetRow`, `sparseRow`). |
| `withSheetLayout` | function | A worksheet with its column definitions and merged ranges set, its rows kept unchecked (a reader's layout, read apart from its rows). |
| `sheetRowFrom` | function | A dense row built from any values, the cell at column `n` being `toCell(items[n], n)`. |
| `sheetRowOf` | function | A row holding the array of cells it is given (not copied): for readers that build one per line. |
| `rowEntries` | function | The cells a row holds with their columns, as nodes, gaps left out. |
| `rowsOf` | function | A worksheet's rows as `SheetRow` nodes (a plain row's built on demand). |
| `rowIndexes` | function | The index of each of a worksheet's rows, explicit or implied, in one array. |
| `rowCellsOf` | function | A worksheet row's cells, `SheetRow` or plain, without building a node. |
| `worksheetOfTrustedRows` | function | A worksheet of rows its caller built valid itself, taken unchecked: the escape hatch for a reader's own output (`worksheetFromRows` checks every cell). |
| `sheetRowOfNumbers` | function | `sheetRowOf` for a row of plain numbers, checked without boxing them. |
| `cellOf` | function | The cell node a row position holds (a plain cell's unstyled node), or `undefined` for a gap. |
| `cellAt` | function | The cell node at a column of a row, or `undefined` where it has none. |
| `sparseRow` | function | A row from its cells' `[column, cell]` entries, in strictly ascending column order (each column between a gap): the readers' constructor for rows whose cells skip columns. |
| `NestedNode` | type | A node that counts as one level of nesting. |
| `DEFAULT_MAX_NESTING_DEPTH` | const | The default maximum nesting depth readers accept. |
| `nestedChildren` | function | The blocks, inlines and shapes directly inside a node. |
| `blocksNestingDepth` | function | The deepest chain of nested blocks, inlines and shapes in `blocks`. |
| `nestingDepth` | function | The nesting depth of a document's blocks; see `blocksNestingDepth`. |
| `encodeDocument` | function | Encode a document to its JSON form as `Schema.encodeEffect(Document)` does, at any nesting depth. |
| `decodeDocument` | function | Decode a document from its JSON form as `Schema.decodeUnknownEffect(Document)` does, at any nesting depth. |
| `encodeDocumentResult` | function | `encodeDocument` as a synchronous `Result`. |
| `decodeDocumentResult` | function | `decodeDocument` as a synchronous `Result`. |
| `candidateTables` | function | Every tabular region of a document (worksheets, prose tables, slide table shapes), in document order, each with a locator, its size and a header guess. |
| `TableRegion` | type | One tabular region: a `WorksheetRegion` or a `ProseTableRegion`. |
| `WorksheetRegion` | interface | A worksheet as a candidate table: its locator, name, extent and header guess. |
| `ProseTableRegion` | interface | A prose table as a candidate table: its locator, caption, size, head rows, text grid and merged cells. |
| `CellSpan` | interface | A merged cell of a prose table: its top-left position and how far it spans. |
| `TableLocator` | type | Where a region is in its document, as a loss entry's path is. |

### `@thomasfosterau/effect-document/profile`

| Export | Kind | Description |
| --- | --- | --- |
| `Profiles` | namespace | The built-in profiles (`Csv`, `Spreadsheet`, `Markdown`, `Html`, `Presentation`, `Full`) as one namespace. |
| `DocBrand` | interface | Phantom marker carrying the feature set a document is permitted to use. |
| `Doc` | type | A `Document` statically restricted to the features `F`. |
| `FeaturesOf` | type | The feature set of a profile, as a phantom-bearing type. |
| `Profile` | interface | A named subset of the schema. |
| `defineProfile` | function | Define a profile from its complete allow-set of features, with optional structural rules (`notWithin`). |
| `NotWithin` | interface | A structural rule: a feature the profile allows, but not inside a given node. |
| `ProfileOptions` | interface | Options for `defineProfile`: structural rules beyond the feature set. |
| `trustAs` | function | Assert (unsafely) that a document belongs to a profile, branding it without a runtime check. |
| `collectFeatures` | function | The set of features a document uses. |
| `collectFeaturesWithin` | function | The features a document uses inside nodes of a given feature. |
| `unsupportedFeatures` | function | Features the document uses that are not in `allowed`. |
| `LossEntry` | interface | One thing `narrow` could not keep. |
| `LossReport` | interface | Everything a narrowing (or a conversion) dropped or down-converted. |
| `NarrowResult` | interface | The narrowed document and the loss report for it. |
| `widen` | function | Widen a document to a superset profile. |
| `narrow` | function | Narrow a document so it conforms to `to`, recording everything that had to be dropped or down-converted. |
| `narrowEffect` | function | Narrow within an Effect. |

### `@thomasfosterau/effect-document/profiles`

| Export         | Kind  | Description                    |
| -------------- | ----- | ------------------------------ |
| `csvFeatures`  | const | CSV/TSV.                       |
| `Csv`          | const | The CSV profile.               |
| `Spreadsheet`  | const | A full spreadsheet (XLSX/ODS). |
| `Markdown`     | const | Markdown/Wikitext.             |
| `Html`         | const | HTML/OOXML/ODF prose.          |
| `Presentation` | const | Presentations (PPTX/Keynote).  |
| `Full`         | const | The maximal profile.           |

### `@thomasfosterau/effect-document/io`

| Export | Kind | Description |
| --- | --- | --- |
| `ParseError` | class | A reader failed to parse source content into the document schema. |
| `ParseErrorCode` | schema | What kind of failure a `ParseError` is, shared by every reader (`InvalidContainer`, `WrongFormat`, `MissingPart`, `Encrypted`, `MalformedXml`, `MalformedBinary`, `MalformedText`, `LimitExceeded`, `Unsupported`). |
| `SourcePosition` | schema | Best-effort source position of a parse failure: `row`, `column`, `part`, `offset`, `component`, `object`, `sheet`, `cell`. |
| `WriteError` | class | A writer failed to render a document into target content. |
| `ProfileViolation` | class | A document used features outside a profile's allowed set. |
| `ConversionError` | class | A conversion pipeline could not be assembled or a bridge step failed. |
| `Text` | interface | Textual content. |
| `Bytes` | interface | Binary content. |
| `Content` | type | Raw content accepted by readers and produced by writers. |
| `text` | function | Construct textual content. |
| `bytes` | function | Construct binary content. |
| `contentToText` | function | View any content as a string (bytes are decoded as UTF-8). |
| `contentToBytes` | function | View any content as bytes (text is encoded as UTF-8). |
| `Reader` | interface | Parses `Content` into a document of its format's profile, failing with a `ParseError`. |
| `AnyReader` | type | A `Reader` for some (existentially-quantified) profile. |
| `makeReaderTag` | function | Create a Context tag for a format's Reader service. |
| `limitNestingDepth` | function | Fail with a `"LimitExceeded"` ParseError when a document nests deeper than `maxDepth` (default `DEFAULT_MAX_NESTING_DEPTH`); otherwise succeed with it unchanged. |
| `Writer` | interface | Renders a document of its format's profile into `Content`, failing with a `WriteError`. |
| `AnyWriter` | type | A `Writer` for some (existentially-quantified) profile. |
| `makeWriterTag` | function | Create a Context tag for a format's Writer service. |
| `Format` | interface | A format bundle for `convert`, with an optional `sniff`, `extensions` and `mimeTypes` for `detect`. |
| `AnyFormat` | type | A `Format` for some (existentially-quantified) profiles. |
| `ConvertOptions` | interface | Options for `convert`. |
| `ConvertResult` | interface | The rendered target content and what was lost getting there. |
| `ConvertError` | type | Every way `convert` can fail. |
| `convert` | function | Convert content from one format to another. |
| `detect` | function | The formats some content may be, most likely first, each with its confidence and evidence; never fails. |
| `Sniffer` | type | A format's recogniser: `Option.some` with its confidence when the content looks like the format. |
| `Sniff` | interface | What a sniffer concluded: its confidence and evidence. |
| `Candidate` | interface | One format `detect` thinks the content may be. |
| `DetectHints` | interface | A file name and MIME type: tie-breakers only. |
| `DetectOptions` | interface | Options for `detect`: the formats to choose among, and the hints. |
| `Detectable` | interface | What `detect` needs of a format: its id, and its sniffer, extensions and MIME types. |
| `HINT_WEIGHT` | const | How much a matching extension or MIME type adds to a candidate's confidence (0.001). |
| `isTruncated` | function | Whether a document is a truncated preview read rather than the whole file. |
| `truncationOf` | function | What a truncated preview read left out: its `maxRows` and the worksheets it cut. |
| `markTruncated` | function | Mark a document as a truncated preview (`meta.truncated`), keeping its profile: for readers. |
| `Truncation` | interface | A preview read's limit and the worksheets it cut. |
| `TRUNCATED_META_KEY` | const | The metadata key a truncated preview read sets (`"truncated"`). |

Every node class also has a `*Encoded` interface: its JSON form (`ParaEncoded`, `WorksheetEncoded`, …), which is what `Schema.encode` produces.

## Formats

Each format family is a subpath of this package, kept off the root barrel. `/csv`, `/rtf`, `/ooxml*` and `/iwork*` are written on [`@thomasfosterau/effect-parse`](https://www.npmjs.com/package/@thomasfosterau/effect-parse), an optional peer you install to use them; `/ooxml*`, `/pdf*` and `/iwork*` load [fflate](https://www.npmjs.com/package/fflate) (ZIP and DEFLATE), a dependency. The root entry, `/schema`, `/profile`, `/profiles` and `/io` load neither.

### Feature support

<!-- feature-matrix:start -->

Generated from each format's read and write profiles by `test/integration/feature-matrix.test.ts`; `R` is read, `W` written, `*` on some kinds of node only (an id on a heading, but not on every node), `–` neither.

| Feature                | CSV | TSV | XLSX | DOCX | PPTX | RTF | PDF | Keynote | Pages | Numbers |
| ---------------------- | :-: | :-: | :--: | :--: | :--: | :-: | :-: | :-----: | :---: | :-----: |
| `inline.str`           |  –  |  –  |  –   |  RW  |  RW  | RW  | RW  |    R    |   R   |    –    |
| `inline.space`         |  –  |  –  |  –   |  RW  |  RW  | RW  | RW  |    R    |   R   |    –    |
| `inline.softBreak`     |  –  |  –  |  –   |  RW  |  RW  | RW  | RW  |    R    |   R   |    –    |
| `inline.lineBreak`     |  –  |  –  |  –   |  RW  |  RW  | RW  |  R  |    R    |   R   |    –    |
| `inline.emph`          |  –  |  –  |  –   |  RW  |  RW  | RW  | RW  |    –    |   –   |    –    |
| `inline.strong`        |  –  |  –  |  –   |  RW  |  RW  | RW  | RW  |    –    |   –   |    –    |
| `inline.underline`     |  –  |  –  |  –   |  RW  |  RW  | RW  |  R  |    –    |   –   |    –    |
| `inline.strikeout`     |  –  |  –  |  –   |  RW  |  RW  | RW  |  R  |    –    |   –   |    –    |
| `inline.superscript`   |  –  |  –  |  –   |  RW  |  –   |  –  |  –  |    –    |   –   |    –    |
| `inline.subscript`     |  –  |  –  |  –   |  RW  |  –   |  –  |  –  |    –    |   –   |    –    |
| `inline.smallCaps`     |  –  |  –  |  –   |  RW  |  –   |  –  |  –  |    –    |   –   |    –    |
| `inline.quoted`        |  –  |  –  |  –   |  –   |  –   |  –  |  –  |    –    |   –   |    –    |
| `inline.cite`          |  –  |  –  |  –   |  –   |  –   |  –  |  –  |    –    |   –   |    –    |
| `inline.code`          |  –  |  –  |  –   |  –   |  –   |  –  | RW  |    –    |   –   |    –    |
| `inline.math`          |  –  |  –  |  –   |  –   |  –   |  –  |  –  |    –    |   –   |    –    |
| `inline.rawInline`     |  –  |  –  |  –   |  –   |  –   |  –  |  –  |    –    |   –   |    –    |
| `inline.link`          |  –  |  –  |  –   |  RW  |  –   |  –  | RW  |    –    |   –   |    –    |
| `inline.image`         |  –  |  –  |  –   |  –   |  –   |  –  |  –  |    –    |   –   |    –    |
| `inline.note`          |  –  |  –  |  –   |  –   |  –   |  –  |  –  |    –    |   –   |    –    |
| `inline.span`          |  –  |  –  |  –   |  RW  |  –   |  –  |  –  |    –    |   –   |    –    |
| `block.plain`          |  –  |  –  |  –   |  RW  |  RW  | RW  | RW  |    R    |   R   |    –    |
| `block.para`           |  –  |  –  |  –   |  RW  |  RW  | RW  | RW  |    R    |   R   |    –    |
| `block.lineBlock`      |  –  |  –  |  –   |  –   |  –   |  –  |  –  |    –    |   –   |    –    |
| `block.codeBlock`      |  –  |  –  |  –   |  RW  |  –   |  –  | RW  |    –    |   –   |    –    |
| `block.rawBlock`       |  –  |  –  |  –   |  –   |  –   |  –  |  –  |    –    |   –   |    –    |
| `block.blockQuote`     |  –  |  –  |  –   |  –   |  –   |  –  |  R  |    –    |   –   |    –    |
| `block.orderedList`    |  –  |  –  |  –   |  RW  |  RW  |  –  | RW  |    –    |   –   |    –    |
| `block.bulletList`     |  –  |  –  |  –   |  RW  |  RW  |  –  | RW  |    –    |   –   |    –    |
| `block.definitionList` |  –  |  –  |  –   |  –   |  –   |  –  |  –  |    –    |   –   |    –    |
| `block.header`         |  –  |  –  |  –   |  RW  |  R   | RW  | RW  |    –    |   –   |    –    |
| `block.horizontalRule` |  –  |  –  |  –   |  –   |  –   |  –  |  R  |    –    |   –   |    –    |
| `block.figure`         |  –  |  –  |  –   |  –   |  –   |  –  |  –  |    –    |   –   |    –    |
| `block.div`            |  –  |  –  |  –   |  –   |  –   |  –  |  –  |    –    |   –   |    –    |
| `block.table`          |  –  |  –  |  –   |  RW  |  –   |  –  |  –  |    –    |   –   |    –    |
| `sheet.worksheet`      | RW  | RW  |  RW  |  –   |  –   |  –  |  –  |    –    |   –   |    R    |
| `sheet.multiple`       |  –  |  –  |  RW  |  –   |  –   |  –  |  –  |    –    |   –   |    R    |
| `sheet.merges`         |  –  |  –  |  RW  |  –   |  –   |  –  |  –  |    –    |   –   |    –    |
| `sheet.columns`        |  –  |  –  |  RW  |  –   |  –   |  –  |  –  |    –    |   –   |    –    |
| `cell.text`            | RW  | RW  |  RW  |  –   |  –   |  –  |  –  |    –    |   –   |    R    |
| `cell.number`          | RW  | RW  |  RW  |  –   |  –   |  –  |  –  |    –    |   –   |    R    |
| `cell.boolean`         | RW  | RW  |  RW  |  –   |  –   |  –  |  –  |    –    |   –   |    R    |
| `cell.date`            |  –  |  –  |  R   |  –   |  –   |  –  |  –  |    –    |   –   |    –    |
| `cell.error`           |  –  |  –  |  RW  |  –   |  –   |  –  |  –  |    –    |   –   |    –    |
| `cell.blank`           | RW  | RW  |  RW  |  –   |  –   |  –  |  –  |    –    |   –   |    R    |
| `cell.formula`         |  –  |  –  |  RW  |  –   |  –   |  –  |  –  |    –    |   –   |    –    |
| `cell.richText`        |  –  |  –  |  –   |  –   |  –   |  –  |  –  |    –    |   –   |    –    |
| `cell.style`           |  –  |  –  |  –   |  –   |  –   |  –  |  –  |    –    |   –   |    –    |
| `deck.slideShow`       |  –  |  –  |  –   |  –   |  RW  |  –  |  –  |    R    |   –   |    –    |
| `deck.notes`           |  –  |  –  |  –   |  –   |  –   |  –  |  –  |    –    |   –   |    –    |
| `shape.textBox`        |  –  |  –  |  –   |  –   |  RW  |  –  |  –  |    R    |   –   |    –    |
| `shape.picture`        |  –  |  –  |  –   |  –   |  –   |  –  |  –  |    –    |   –   |    –    |
| `shape.table`          |  –  |  –  |  –   |  –   |  –   |  –  |  –  |    –    |   –   |    –    |
| `shape.placeholder`    |  –  |  –  |  –   |  –   |  RW  |  –  |  –  |    –    |   –   |    –    |
| `attr.id`              |  –  |  –  |  –   | R*W* |  –   |  –  |  –  |    –    |   –   |    –    |
| `attr.classes`         |  –  |  –  |  –   |  –   |  –   |  –  |  –  |    –    |   –   |    –    |
| `attr.keyValue`        |  –  |  –  |  R   |  –   |  –   |  –  |  –  |    –    |   –   |    –    |
| `attr.style`           |  –  |  –  |  –   |  –   |  –   |  –  |  –  |    –    |   –   |    –    |

<!-- feature-matrix:end -->

### CSV and TSV (`/csv`)

CSV and TSV: a reader and writer for the `Csv` profile (one worksheet of text, number, boolean and blank cells), dialects, quoting, comments, type inference, a chunked streaming scanner, and seeded synthetic data. Parsing is built on [`@thomasfosterau/effect-parse`](https://www.npmjs.com/package/@thomasfosterau/effect-parse).

#### Reading and writing

```ts
import * as Effect from "effect/Effect";
import { contentToText, text } from "@thomasfosterau/effect-document";
import * as Csv from "@thomasfosterau/effect-document/csv";

const program = Effect.gen(function* () {
  // a single worksheet: the header row is sniffed, and the age and admin
  // columns are inferred as number and boolean cells
  const doc = yield* Csv.makeCsvReader().read(text("name,age,admin\nalice,30,true\n"));
  const out = yield* Csv.makeCsvWriter().write(doc);
  return contentToText(out); // "name,age,admin\nalice,30,true\n"
});
```

By default the reader sniffs the header row: the first row is the header when every value in it is text and some column below it is all numbers or booleans. Pass `treatFirstRowAsHeader: true` or `false` to decide instead (an all-text file needs `true` for its first row to be a header). Each column is typed as a whole: a column is numeric only if every value in it is a number, so a code such as `007` keeps its whole column as written. Pass `inference: "cell"` to type each value on its own instead. Only plain decimals whose digits a double holds exactly become numbers, so 20-digit IDs stay text; pass `exactNumbers: false` to read every value the number grammar matches as `Number` of it instead, as d3-dsv and uDSV do (lossy past a double's digits).

For rows rather than a document, `Csv.readCsvRows(text, options)` takes the same options and returns `{ headers, rows }`: the header (or `null`) and each row's values as plain strings, numbers, booleans and `null` (a null spelling), typed exactly as `read` types its cells. It is the like-for-like counterpart of d3-dsv's `autoType` and Papa Parse's `dynamicTyping`, and the cheaper choice when the table goes straight into code (see the performance table in the repository README).

```ts
const { headers, rows } = yield * Csv.readCsvRows("name,age\nalice,30\nbob,\n");
// headers: ["name", "age"]; rows: [["alice", 30], ["bob", null]]
```

`Csv.format` and `Csv.tsvFormat` are the bundles for `convert`; `Csv.makeFormat({ reader, writer })` builds one with options. Pass `inferTypes: false` to keep every value a text cell exactly as written, a `dialect` (`StandardDialect`, `TsvDialect` or your own `CsvDialect`) for other separators and quoting, and `skipRows`, `lineCommentMarker`, `trimWhitespace` or `filterEmpty` to clean messy input. A malformed file (an unterminated quote, a ragged row under a header) fails with a `ParseError` carrying its position in the source.

The writer quotes only the fields that need it (`quoting: "minimal"`); `quoting` also takes `"all"`, `"nonNumeric"` and `"none"`, after Python's `csv.QUOTE_*`. It doubles a wrapper inside a quoted field, as RFC 4180 specifies, or escapes it with `escapeChar` (`"\\"`, say) instead; a field holding the escape character itself fails the write, and the reader has no escape-character option yet. Rows end with the dialect's `linebreak`: LF in `StandardDialect`, CRLF in `Rfc4180Dialect`. Set `bom: true` for Excel to detect UTF-8, `headers` to write a header row first, and `padRows` to pad short rows into a rectangle. Numbers are written as shortest round-trip decimals with no exponent form (`formatNumber` overrides it). `renderCsvStream` renders a `Stream` of rows one chunk per row. A worksheet is sparse, so the writer writes each gap between cells as an empty field and each row the sheet does not hold as an empty line; `maxFields` (default `DEFAULT_MAX_FIELDS`, five million) bounds how far those gaps may expand, and a write past it fails with a `WriteError`.

**Formula injection.** Spreadsheet apps run a cell that starts with `=`, `+`, `-` or `@` as a formula when the file is opened, so a value such as `=HYPERLINK(...)` from untrusted input can act on whoever opens the file. Set `escapeFormulae: true` when writing such data for people to open: it prefixes `'` to text fields that start with one of those characters, a tab or a CR, and quotes them. It changes the values, so leave it off for files that programs read.

#### Streaming

`readStream` yields rows without building the document, and `scanCsvStream` scans text that arrives in chunks; a field, a quoted line break or a CRLF may span chunk boundaries:

```ts
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Csv from "@thomasfosterau/effect-document/csv";

const chunks = Stream.make("id,na", "me\n1,a", "lice\n2,bob\n");
const rows = Csv.scanCsvStream(chunks, Csv.StandardDialect, { treatFirstRowAsHeader: true });
const all = Stream.runCollect(rows); // [["1", "alice"], ["2", "bob"]]
```

#### Synthetic data

```ts
import * as Csv from "@thomasfosterau/effect-document/csv";

// the same seed always gives the same table
const doc = Csv.synthesizeDocument({ columns: ["id", "email"], quantity: 1_000, seed: 42 });
```

#### API reference

##### `@thomasfosterau/effect-document/csv`

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
| `CsvValue` | type | A typed CSV value, as `readCsvRows` returns it: `null` for a null spelling. |
| `CsvRows` | interface | A CSV table of typed values: its header row (or `null`) and its data rows. |
| `readCsvRows` | function | Read CSV text into rows of typed values, typed as `read` types its cells. |
| `makeCsvReader` | function | Create a CSV Reader with the given options baked in. |
| `sniffCsv` / `sniffTsv` | const | The CSV and TSV sniffers for `detect`: text whose lines split into the same number of fields, on a 64 KiB sample. |
| `SNIFF_SAMPLE_BYTES` | const | How much of the input the CSV and TSV sniffers look at (64 KiB). |
| `sniffDialect` | function | The dialect a bounded sample of text follows: separator, line break, preamble lines to skip and whether the first row is a header, as reader options with a confidence. |
| `SniffedDialect` | interface | What `sniffDialect` found: the reader options, its confidence and its evidence. |
| `SNIFF_SEPARATORS` | const | The separators `sniffDialect` tries: comma, semicolon, tab and pipe. |
| `CsvReaderTag` | const | Context tag for dependency-injection style usage. |
| `CsvReaderLive` | const | Layer providing a CSV Reader with default options. |
| `makeCsvReaderLayer` | function | Layer providing a CSV Reader with custom options. |
| `CsvQuoting` | type | When to quote fields, after Python's `csv.QUOTE_*`. |
| `CsvWriterOptions` | interface | Options for the CSV writer. |
| `DEFAULT_MAX_FIELDS` | const | The default `CsvWriterOptions.maxFields`: core's dense-grid budget, five million. |
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

### Office Open XML (`/ooxml`)

Office Open XML: readers and writers for Excel workbooks (`Xlsx`), Word documents (`Docx`) and PowerPoint decks (`Pptx`), implemented directly on SpreadsheetML, WordprocessingML and PresentationML. The ZIP container is read and written with [fflate](https://www.npmjs.com/package/fflate).

Import the three namespaces from `/ooxml`, or one format from its own subpath (`@thomasfosterau/effect-document/ooxml/xlsx`, `/ooxml/docx`, `/ooxml/pptx`) so a bundler keeps only that one.

#### What each format covers

| Format | Profile | Reads and writes |
| --- | --- | --- |
| XLSX | `Spreadsheet` (from `effect-document/profiles`) | every worksheet; shared and inline strings, numbers, booleans, errors and formulas; column widths (`<cols>`, in characters of the default font) and merged ranges (`<mergeCells>`). Dates are written as ISO-8601 text and read back as text; styles and row heights are not read or written yet. |
| DOCX | `Docx` | paragraphs, headings (`Heading1`–`Heading6`, with a bookmark around the whole heading as its id), bookmarked text as a `Span` with the bookmark as its id, runs with bold / italic / underline / strikeout / superscript / subscript / small caps, hyperlinks (a `#name` link goes to the bookmark `name`), bullet and ordered lists, tables. |
| PPTX | `Pptx` | slides of text boxes and placeholders holding paragraphs, headings and bullet / numbered lists. No pictures or speaker notes yet. |

#### Usage

```ts
import * as Effect from "effect/Effect";
import {
  bytes,
  cell,
  document,
  header,
  para,
  str,
  trustAs,
  worksheet,
} from "@thomasfosterau/effect-document";
import type { FeaturesOf } from "@thomasfosterau/effect-document";
import { Docx, Xlsx } from "@thomasfosterau/effect-document/ooxml";

const program = Effect.gen(function* () {
  // a workbook: one worksheet of typed cells
  const book = document([worksheet("Sales", [[cell.text("North"), cell.number(42000)]])]);
  const xlsx = yield* Xlsx.makeXlsxWriter().write(trustAs<Xlsx.SpreadsheetFeature>(book));
  const back = yield* Xlsx.makeXlsxReader().read(xlsx);

  // a Word document
  const letter = trustAs<FeaturesOf<typeof Docx.profile>>(
    document([header(1, [str("Hello")]), para([str("World")])]),
  );
  const docx = yield* Docx.makeDocxWriter().write(letter);
  return { sheets: back.blocks.length, docx };
});
```

`trustAs` asserts a document's profile without checking it; use a profile's `validate` (or `narrow`) on documents you did not build yourself. Each namespace's `format` plugs into `convert`, and converting between them reports what the target cannot hold: DOCX → PPTX wraps loose prose into a single slide. A missing or malformed part fails with a `ParseError` whose `cause` says which.

Every reader takes a `limits` option against zip bombs: `maxEntries`, the most zip entries (default 10,000); `maxEntrySize`, the largest uncompressed part read (256 MiB); and `maxTotalSize`, the most uncompressed bytes inflated in total (512 MiB). A limit left out or `undefined` keeps its default. Parts are inflated only when read, after their declared size is checked, so a zip bomb fails with a `ParseError` whose `code` is `"LimitExceeded"`. The names, defaults and messages are the same as the iWork readers' `limits`.

The XLSX entry also exports its A1-notation helpers (`parseA1`, `parseA1Range`, `toA1`, `indexToCol`, `colToIndex`) and the SpreadsheetML cell codec.

#### API reference

The root entry exports the three namespaces `Xlsx`, `Docx` and `Pptx`; each subpath exports one of them flat.

##### `@thomasfosterau/effect-document/ooxml/xlsx`

| Export | Kind | Description |
| --- | --- | --- |
| `profile` | const | The XLSX (write) profile. |
| `XlsxFormatOptions` | interface | Options for the XLSX format bundle. |
| `makeFormat` | function | Create an XLSX Format bundle with custom reader/writer options. |
| `format` | const | The XLSX format bundle with default options, for use with `convert`. |
| `indexToCol` | function | Convert a 0-indexed column number to letters. |
| `colToIndex` | function | Convert column letters to a 0-indexed column number. |
| `CellRef` | interface | A cell position, 0-indexed (`A1` is `{ col. |
| `AbsoluteCellRef` | interface | A cell reference that may pin its column and/or row with `$` ("$A1", "B$2", "$C$3"). |
| `CellRange` | interface | A rectangular range between two corner references ("A1:B2"); a lone cell is a 1x1 range. |
| `toA1` | function | Render a 0-indexed (col, row) pair as an A1 reference. |
| `a1Cell` | const | A plain A1 reference, as in a SpreadsheetML cell's `r` attribute. |
| `a1AbsoluteCell` | const | An A1 reference with optional `$` markers. |
| `a1Range` | const | An A1 range, "A1:B2", or a single cell. |
| `parseA1` | function | Parse an A1 reference into a 0-indexed (col, row) pair, or null if invalid |
| `parseA1Absolute` | function | Parse an A1 reference that may carry `$` markers, or null if invalid |
| `parseA1Range` | function | Parse an A1 range ("A1:B2", "$A$1:$B$2", or a single cell), or null if invalid |
| `escapeXml` | function | Escape text content for XML |
| `escapeAttr` | function | Escape an attribute value for XML |
| `unescapeXml` | function | Unescape XML text content and attribute values |
| `XmlElement` | interface | A parsed XML element |
| `parseXmlResult` | function | Parse an XML document into its root element, or a `ParseError` that points at the problem (line, column and what was expected). |
| `parseXml` | function | Parse an XML document and return its root element. |
| `findChild` | function | Find the first direct child with the given local name |
| `findChildren` | function | Find all direct children with the given local name |
| `findAll` | function | Find all descendants with the given local name (depth-first, document order) |
| `getAttr` | function | Get an attribute value, matching with or without a namespace prefix. |
| `encodeXstring` | function | Encode a string as SpreadsheetML ST_Xstring. |
| `escapeXstring` | function | Escape and ST_Xstring-encode text for a SpreadsheetML element. |
| `SharedStrings` | class | Accumulates the shared strings table while rendering cells. |
| `cellToSpreadsheetMl` | function | Render a cell as a SpreadsheetML `<c>` element body, or null for a blank cell (blank cells are omitted entirely). |
| `decodeXstring` | function | Decode SpreadsheetML's `_xHHHH_` escapes (ST_Xstring), which carry characters XML 1.0 can't (control characters, lone surrogates). |
| `collectText` | function | Concatenate all `<t>` descendants of an element (handles rich-text runs), skipping phonetic guides (`<rPh>`), which annotate the base text rather than belong to it. |
| `spreadsheetMlToCell` | function | Convert a parsed SpreadsheetML `<c>` element into a typed cell. |
| `xlsxFeatures` | const | The features the XLSX profile allows, as a list. |
| `Xlsx` | const | What the XLSX writer preserves. |
| `XlsxFeature` | type | The features the XLSX profile allows, as a type. |
| `XlsxRead` | const | What the XLSX reader produces. |
| `XlsxReadFeature` | type | The features of `XlsxRead`, what the XLSX reader produces, as a type. |
| `SpreadsheetFeature` | type | The XLSX reader's features under their old name. |
| `XlsxReaderOptions` | interface | Options for the XLSX reader. |
| `DEFAULT_MAX_CELLS` | const | The default `XlsxReaderOptions.maxCells`. |
| `makeXlsxReader` | function | Create an XLSX Reader with the given options baked in. |
| `sniffXlsx` | const | The XLSX sniffer for `detect`: a zip whose main part is a SpreadsheetML workbook. |
| `XlsxReaderTag` | const | Context tag for dependency-injection style usage. |
| `XlsxReaderLive` | const | Layer providing an XLSX Reader with default options. |
| `makeXlsxReaderLayer` | function | Layer providing an XLSX Reader with custom options. |
| `sanitizeSheetNames` | function | Make sheet names Excel accepts, deterministically. |
| `XlsxWriterOptions` | interface | Options for the XLSX writer. |
| `makeXlsxWriter` | function | Create an XLSX Writer with the given options baked in. |
| `XlsxWriterTag` | const | Context tag for dependency-injection style usage. |
| `XlsxWriterLive` | const | Layer providing an XLSX Writer with default options. |
| `makeXlsxWriterLayer` | function | Layer providing an XLSX Writer with custom options. |

##### `@thomasfosterau/effect-document/ooxml/docx`

| Export | Kind | Description |
| --- | --- | --- |
| `profile` | const | The DOCX profile. |
| `DocxFormatOptions` | interface | Options for the DOCX format bundle. |
| `makeFormat` | function | Create a DOCX Format bundle with custom reader/writer options. |
| `format` | const | The DOCX format bundle with default options, for use with `convert`. |
| `docxFeatures` | const | The features the DOCX profile allows, as a list. |
| `Docx` | const | The DOCX (WordprocessingML) profile. |
| `DocxFeature` | type | The features the DOCX profile allows, as a type. |
| `DocxReaderOptions` | interface | Options for the DOCX reader. |
| `makeDocxReader` | function | Create a DOCX Reader. |
| `sniffDocx` | const | The DOCX sniffer for `detect`: a zip whose main part is a WordprocessingML document. |
| `DocxReaderTag` | const | The Context tag for the DOCX reader, so a program can depend on a DOCX reader and have one provided. |
| `DocxReaderLive` | const | A Layer providing the default DOCX reader for `DocxReaderTag`. |
| `DocxWriterOptions` | interface | Options for the DOCX writer. |
| `makeDocxWriter` | function | Create a DOCX Writer. |
| `DocxWriterTag` | const | The Context tag for the DOCX writer, so a program can depend on a DOCX writer and have one provided. |
| `DocxWriterLive` | const | A Layer providing the default DOCX writer for `DocxWriterTag`. |

##### `@thomasfosterau/effect-document/ooxml/pptx`

| Export | Kind | Description |
| --- | --- | --- |
| `profile` | const | The PPTX profile. |
| `PptxFormatOptions` | interface | Options for the PPTX format bundle. |
| `makeFormat` | function | Create a PPTX Format bundle with custom reader/writer options. |
| `format` | const | The PPTX format bundle with default options, for use with `convert`. |
| `pptxFeatures` | const | The features the PPTX profile allows, as a list. |
| `Pptx` | const | The PPTX (PresentationML) profile. |
| `PptxFeature` | type | The features the PPTX profile allows, as a type. |
| `PptxRead` | const | What the PPTX reader produces. |
| `PptxReadFeature` | type | The features of `PptxRead`, what the PPTX reader produces, as a type. |
| `PptxReaderOptions` | interface | Options for the PPTX reader. |
| `makePptxReader` | function | Create a PPTX Reader. |
| `sniffPptx` | const | The PPTX sniffer for `detect`: a zip whose main part is a PresentationML presentation. |
| `PptxReaderTag` | const | The Context tag for the PPTX reader, so a program can depend on a PPTX reader and have one provided. |
| `PptxReaderLive` | const | A Layer providing the default PPTX reader for `PptxReaderTag`. |
| `PptxWriterOptions` | interface | Options for the PPTX writer. |
| `makePptxWriter` | function | Create a PPTX Writer. |
| `PptxWriterTag` | const | The Context tag for the PPTX writer, so a program can depend on a PPTX writer and have one provided. |
| `PptxWriterLive` | const | A Layer providing the default PPTX writer for `PptxWriterTag`. |

### RTF (`/rtf`)

Rich Text Format: a reader and writer for the `Rtf` profile, paragraphs and headings with bold, italic, underline and strikeout runs. Destinations the reader does not model (font and colour tables, stylesheets, pictures, headers and footers, `\*` destinations) are skipped; `\uN` escapes and their ANSI fallbacks are handled.

#### Usage

```ts
import * as Effect from "effect/Effect";
import { blocksToText, contentToText, text } from "@thomasfosterau/effect-document";
import * as Rtf from "@thomasfosterau/effect-document/rtf";

const program = Effect.gen(function* () {
  const doc = yield* Rtf.makeRtfReader().read(text("{\\rtf1\\ansi Hello {\\b bold}\\par}"));
  blocksToText(doc.blocks); // "Hello bold"
  const out = yield* Rtf.makeRtfWriter().write(doc);
  return contentToText(out); // "{\\rtf1\\ansi\\deff0\\fs24\n\\pard Hello {\\b bold}\\par\n}"
});
```

Headings are written as bold, larger paragraphs (RTF has no semantic headings). Because a heading is bold, bold inside one can't be told apart from it: the `Rtf` profile keeps `Strong` out of headings, so `convert` unwraps it there and reports the loss. Use `Rtf.format` with `convert` to move between RTF and the other formats: DOCX → RTF reports the links, lists and tables it has to drop.

#### API reference

##### `@thomasfosterau/effect-document/rtf`

| Export | Kind | Description |
| --- | --- | --- |
| `profile` | const | The RTF profile. |
| `format` | const | The RTF format bundle, for use with `convert`. |
| `rtfFeatures` | const | The features the RTF profile allows, as a list. |
| `Rtf` | const | The RTF profile. |
| `RtfFeature` | type | The features the RTF profile allows, as a type. |
| `makeRtfReader` | function | Create an RTF Reader. |
| `sniffRtf` | const | The RTF sniffer for `detect`: text that opens with `{\rtf`. |
| `RtfReaderTag` | const | The Context tag for the RTF reader, so a program can depend on an RTF reader and have one provided. |
| `RtfReaderLive` | const | A Layer providing the default RTF reader for `RtfReaderTag`. |
| `RtfWriterOptions` | interface | Options for the RTF writer. |
| `makeRtfWriter` | function | Create an RTF Writer. |
| `RtfWriterTag` | const | The Context tag for the RTF writer, so a program can depend on an RTF writer and have one provided. |
| `RtfWriterLive` | const | A Layer providing the default RTF writer for `RtfWriterTag`. |

### PDF (`/pdf`)

PDF: a reader and writer for the `Pdf` profile, on top of a self-contained PDF object layer (`/pdf/cos`), with [fflate](https://www.npmjs.com/package/fflate) for `/FlateDecode`.

#### Usage

```ts
import * as Effect from "effect/Effect";
import {
  blocksToText,
  document,
  header,
  para,
  str,
  trustAs,
} from "@thomasfosterau/effect-document";
import * as Pdf from "@thomasfosterau/effect-document/pdf";

const program = Effect.gen(function* () {
  const doc = trustAs<Pdf.PdfFeature>(
    document([header(1, [str("Title")]), para([str("Body text.")])]),
  );
  const pdf = yield* Pdf.makePdfWriter({ pageSize: "letter" }).write(doc); // Bytes
  const back = yield* Pdf.makePdfReader().read(pdf); // Doc<PdfFeature>
  return blocksToText(back.blocks); // "Title\nBody text."
});
```

**Reading** recovers prose from the page layout: headings (ranked by font size), paragraphs (including ones broken across pages), bullet/ordered/nested lists, code blocks (runs of monospaced lines, indentation kept), bold, italic, inline code and links (from link annotations), plus the document information dictionary as metadata. A tagged PDF (one with a structure tree, as Word, LibreOffice, Chrome and this package's writer produce) is read from its tags instead: headings at their tagged level, paragraphs, lists (ordered or bulleted by their numbering or labels), code blocks and block quotes come from the structure elements, through the file's `/RoleMap`, and only the inline styling still comes from the fonts. As Tagged PDF specifies, only a soft hyphen (U+00AD) at a tagged line end joins a word across lines; a plain hyphen there is text, and the space after it is kept. The reader falls back to the layout when the tree is missing, unreadable, or owns less than 98% of the visible text; there, a heading whose text is a bookmark's title takes its level from the outline's depth, and the rest are ranked by size. It handles simple and composite (Type 0) fonts, `/ToUnicode` CMaps, standard and custom encodings, `/ActualText`, Form XObjects and rotated pages. Damaged files are repaired by scanning for objects. Encrypted files are refused.

**Scanned pages** (images with no text layer) read as empty unless you give the reader an OCR engine. Either way, the pages left without text are listed in the document's `pagesWithoutText` metadata (1-based page numbers). No engine is bundled: implement `OcrEngineShape` over the one you use (Tesseract.js, a cloud OCR API, …) and pass it as `ocr`, or provide it as the `OcrEngine` service and use `PdfOcrReaderLive`:

```ts
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Pdf from "@thomasfosterau/effect-document/pdf";

declare const myEngine: Pdf.OcrEngineShape; // recognize(image) => Effect<ReadonlyArray<OcrWord>, OcrError>

const reader = Pdf.makePdfReader({ ocr: myEngine });
// or, as a service:
const ReaderLive = Pdf.PdfOcrReaderLive.pipe(Layer.provide(Layer.succeed(Pdf.OcrEngine, myEngine)));
```

The engine is called once for each image a textless page paints, in painting order, and never for pages that have text. It gets the image as the PDF stores it. JPEG, JPEG 2000, CCITT fax and JBIG2 data arrive still encoded (`_tag: "Encoded"`, with the codec's `parameters` and any JBIG2 `globals`). Other images arrive as decoded gray, RGB or CMYK samples (`_tag: "Samples"`). Images in other colour spaces (indexed, separation, …) are skipped. The engine returns words with pixel boxes (origin at the top-left), which the reader places on the page and lays out like any other text. An `OcrError` fails the read with a `ParseError` naming the page.

**Writing** typesets a document onto pages (headings are bold, so `PdfWrite` keeps `Strong` out of headings, and `convert` unwraps it there with a loss entry): word-wrapped paragraphs, headings, nested lists, code blocks, block quotes, rules, bold/italic/underline/strikeout, inline code and clickable links. It uses the standard 14 fonts (Helvetica, Courier) with WinAnsiEncoding, so nothing is embedded; characters outside WinAnsiEncoding are written as `?`.

The output is a tagged PDF: a structure tree (`/StructTreeRoot`) records each heading (`H1`–`H6`), paragraph (`P`), list (`L` / `LI` / `Lbl` / `LBody`, with its numbering), code block (`Code`), block quote and link, and marks the text each owns, so screen readers and other tools see the document's structure; rules, underlines and quote bars are marked as artifacts. A document's `lang` metadata becomes the catalog's `/Lang`. The headings also become the document outline (bookmarks), nested by level, each going to its heading.

The object layer is on its own subpath, for working with PDF structure directly:

```ts
import { PdfFile, rewritePdf } from "@thomasfosterau/effect-document/pdf/cos";

declare const data: Uint8Array;
const file = PdfFile.open(data); // xref tables and streams, object streams, incremental updates, repair
file.pages().length;
file.lookupDict(file.catalog, "Pages");
const saved = rewritePdf(file); // re-serialize (optionally with replaced objects)
```

The object layer is synchronous and throws: `PdfSyntaxError` (with the byte `offset`, and `code: "LimitExceeded"` when arrays and dictionaries nest deeper than `MAX_OBJECT_NESTING`), `PdfFilterError` (with the `filter`) and `PdfEncryptedError`. The reader and writer turn those into a `ParseError` / `WriteError` in the error channel.

#### API reference

##### `@thomasfosterau/effect-document/pdf`

| Export | Kind | Description |
| --- | --- | --- |
| `decodeTextString` | function | Decode a text string. |
| `glyphToUnicode` | function | The Unicode text for a glyph name. |
| `PageImage` | interface | An image the page paints: an Image XObject drawn with `Do`, or an inline image. |
| `PageLink` | interface | A URI link annotation. |
| `PageText` | interface | A page's positioned text, links and images. |
| `TextGlyph` | interface | A shown glyph, positioned on the page (origin bottom-left, y up). |
| `extractPageText` | function | Extract the positioned text of one page. |
| `Glyph` | interface | One decoded character code. |
| `PdfFont` | interface | A font, as text extraction needs it. |
| `loadFont` | function | Load a font dictionary for text extraction. |
| `layoutBlocks` | function | Infer prose blocks from the text of a document's pages. |
| `profile` | const | The PDF profile. |
| `format` | const | The PDF format bundle, for use with `convert`. |
| `pdfFeatures` | const | The features the PDF profile allows, as a list. |
| `Pdf` | const | The PDF profile. |
| `PdfFeature` | type | The features the PDF profile allows, as a type. |
| `PdfWrite` | const | What the PDF writer preserves through `read(write(doc))` (#109). |
| `PdfWriteFeature` | type | The features of `PdfWrite`, what the PDF writer accepts, as a type. |
| `pdfBytes` | function | PDF bytes from content; text is taken one byte per character (Latin-1). |
| `readMeta` | function | The document information dictionary as metadata. |
| `openPdf` | function | Open a PDF, failing with a `ParseError` if it can't be read or is encrypted. |
| `readPages` | function | The positioned text of every page. |
| `pagesWithoutText` | function | The 1-based numbers of the pages that paint images but have no text. |
| `PdfReaderOptions` | interface | Options for the PDF reader: the nesting-depth limit and the OCR engine. |
| `makePdfReader` | function | Create a PDF Reader. |
| `sniffPdf` | const | The PDF sniffer for `detect`: the `%PDF-` header in the first kilobyte. |
| `PdfReaderTag` | const | The Context tag for the PDF reader, so a program can depend on a PDF reader and have one provided. |
| `PdfReaderLive` | const | A Layer providing the default PDF reader for `PdfReaderTag`. |
| `PdfOcrReaderLive` | const | A Layer providing a PDF reader for `PdfReaderTag` that OCRs scanned pages with the `OcrEngine` it requires. |
| `OcrError` | class | An OCR engine could not recognise an image: why, and the engine's own failure if any. |
| `OcrCodec` | type | The image codecs passed to an `OcrEngine` still encoded. |
| `OcrEncodedImage` | interface | An image in a codec the PDF reader does not decode, passed through as the file stores it. |
| `OcrSampledImage` | interface | An image as decoded samples. |
| `OcrImage` | type | An image for an `OcrEngine`, either still encoded or as samples. |
| `OcrWord` | interface | A recognised word and its bounding box, in the image's pixels with the origin at the top-left. |
| `OcrEngineShape` | interface | An OCR engine: recognises the words in an image, in reading order. |
| `OcrEngine` | const | The Context tag for the OCR engine the PDF reader uses on scanned pages. |
| `toOcrImage` | function | A page image as an `OcrImage`, or none when it can't be given to an engine. |
| `ocrGlyphs` | function | Recognised words as page glyphs, one per line of text. |
| `PAGE_SIZES` | const | Page sizes in points. |
| `PdfWriterOptions` | interface | Options for the PDF writer. |
| `renderPdf` | function | Render a PDF-profile document to PDF bytes. |
| `makePdfWriter` | function | Create a PDF Writer. |
| `PdfWriterTag` | const | The Context tag for the PDF writer, so a program can depend on a PDF writer and have one provided. |
| `PdfWriterLive` | const | A Layer providing the default PDF writer for `PdfWriterTag`. |

##### `@thomasfosterau/effect-document/pdf/cos`

| Export | Kind | Description |
| --- | --- | --- |
| `PdfString` | interface | A PDF string. |
| `PdfName` | interface | A PDF name (`/Type`), with `#xx` escapes decoded. |
| `PdfArray` | interface | A PDF array. |
| `PdfDict` | interface | A PDF dictionary. |
| `PdfStream` | interface | A PDF stream. |
| `PdfRef` | interface | An indirect reference (`12 0 R`). |
| `PdfObject` | type | Any PDF object. |
| `pdfString` | function | A PDF string object from raw bytes, written in hex (`<…>`) when `hex` is set. |
| `pdfLatin1` | function | A string from a JavaScript string's code units, one byte each (Latin-1). |
| `pdfTextString` | function | A text string (§7.9.2.2). |
| `pdfName` | function | A PDF name object (`/Name`). |
| `pdfArray` | function | A PDF array object. |
| `pdfRef` | function | An indirect reference (`num gen R`) to object `num`, generation `gen` (default 0). |
| `pdfDict` | function | A dictionary from a record; `undefined` values are left out. |
| `pdfStream` | function | A PDF stream object. |
| `isString` | function | Whether an object is a PDF string. |
| `isName` | function | Whether an object is a PDF name, and (when given) that name. |
| `isArray` | function | Whether an object is a PDF array. |
| `isDict` | function | Whether an object is a PDF dictionary. |
| `isStream` | function | Whether an object is a PDF stream. |
| `isRef` | function | Whether an object is an indirect reference. |
| `dictOf` | function | The dictionary of a dictionary or a stream. |
| `bytesToLatin1` | function | Decode a string's bytes one byte per character (Latin-1). |
| `latin1ToBytes` | const | A string's characters as bytes, one byte per character (Latin-1; higher code points are truncated). |
| `PdfSyntaxError` | class | A syntax error at a byte offset in the input. |
| `isWhitespace` | function | Whether a byte is PDF white-space (NUL, tab, LF, FF, CR or space). |
| `Keyword` | interface | A bare keyword. |
| `Token` | type | A lexical token. |
| `Lexer` | class | A cursor over PDF bytes. |
| `LengthResolver` | type | Resolves an indirect `/Length` while reading a stream. |
| `isKeyword` | function | Whether a parsed item is a bare keyword (`obj`, `R`, an operator) rather than an object. |
| `indexOf` | function | Find a byte sequence at or after `from`. |
| `lastIndexOf` | function | Find a byte sequence at or before `from`, searching backwards. |
| `ascii` | function | A string's character codes as a byte array. |
| `IndirectObject` | interface | An indirect object (`num gen obj … endobj`). |
| `MAX_OBJECT_NESTING` | const | How deeply arrays and dictionaries may nest in one object. |
| `Parser` | class | Reads PDF objects from a lexer. |
| `parseObject` | function | Parse a single object from bytes (e.g. |
| `Operation` | interface | One content-stream operation. |
| `parseContentStream` | function | Tokenize a content stream into operations (§7.8.2). |
| `PdfFilterError` | class | A stream could not be decoded. |
| `IMAGE_FILTERS` | const | Filters whose output is an encoded image, left for the caller. |
| `flateEncode` | function | Deflate data for a FlateDecode stream. |
| `applyFilter` | function | Apply one named filter. |
| `Decoded` | interface | The result of decoding a stream. |
| `decodeFilters` | function | Decode a stream's data through its `/Filter` chain. |
| `XrefEntry` | type | Where an indirect object lives. |
| `PdfPage` | interface | A page of the document, with its inherited attributes resolved. |
| `PdfFile` | class | A parsed PDF file. |
| `serializeObject` | function | Render an object as PDF syntax. |
| `flateStream` | function | A stream whose data is Flate-compressed (unless compression would not help). |
| `TrailerOptions` | interface | Options for the file trailer. |
| `serializeFile` | function | Write a complete file from numbered objects. |
| `PdfBuilder` | class | Assembles a new PDF file from indirect objects. |
| `fileId` | function | A trailer `/ID`. |
| `PdfEncryptedError` | class | An operation that cannot handle an encrypted file was given one. |
| `rewritePdf` | function | Save a parsed file as a new, self-contained PDF. |

### Apple iWork (`/iwork`)

Read-only Apple iWork readers: Keynote (`.key`, slide text), Pages (`.pages`, body text) and Numbers (`.numbers`, sheet structure), plus the container codec they are built on.

> **Experimental.** iWork files are reverse-engineered binary bundles, so these readers are best-effort and read _text_ only: Keynote yields each slide's text in the show's order (its slide tree, nested slides after their parent), Pages its body paragraphs, Numbers its sheets without cell values. Writing needs Apple's proprietary object-graph schemas and is not supported. Password-protected documents are detected and refused.
>
> Known limits (#99): the Pages reader takes the text of every storage in the file, so headers, footers, footnotes, text boxes, table cells and template text are mixed into the body; a file from another iWork app (a `.key` read as Pages) is read rather than refused; and Numbers reports no loss for the cell values it does not read.

#### Usage

```ts
import * as Effect from "effect/Effect";
import { blocksToText, bytes, convert } from "@thomasfosterau/effect-document";
import * as Keynote from "@thomasfosterau/effect-document/iwork/keynote";
import * as Rtf from "@thomasfosterau/effect-document/rtf";

declare const deck: Uint8Array; // the bytes of a .key file

const program = Effect.gen(function* () {
  const doc = yield* Keynote.makeKeynoteReader().read(bytes(deck));
  // or straight into a writable format; the loss report says what was flattened
  const { content, loss } = yield* convert({
    from: Keynote.format,
    to: Rtf.format,
    input: bytes(deck),
  });
  return { text: blocksToText(doc.blocks), content, loss };
});
```

Each app has its own subpath (`/iwork/keynote`, `/iwork/pages`, `/iwork/numbers`); `/iwork` exports all three as namespaces plus `Codec`.

Every reader takes `IworkReaderOptions`:

- `limits` (`BundleLimits`): `maxEntries`, the most zip entries (default 10,000); `maxEntrySize`, the largest uncompressed entry (256 MiB); and `maxTotalSize`, the most uncompressed bytes inflated in total (512 MiB). A limit left out or `undefined` takes its default (`DEFAULT_BUNDLE_LIMITS`). A zip bomb fails with `LimitExceeded` instead of exhausting memory, and the reader's `ParseError` has `code: "LimitExceeded"`. The names, defaults and messages are the same as the OOXML readers' `limits`. Only `Index/*.iwa` components are inflated; media is read on demand with `bundle.readEntry`.
- `lenient`: skip a component that fails to decode, with a logged warning (`Effect.logWarning`), instead of failing the whole read.

#### Documents saved as a directory

A `.key`, `.pages` or `.numbers` can be saved as a folder (a package directory) rather than a single zipped file. The readers take only `Content` bytes, so read a folder bundle in two steps: open it with the codec's `openBundleDirectory`, which reads just the `Index/*.iwa` components (or an inner `Index.zip`) through Effect's `FileSystem` service, under the same `limits` and with the same password-protection check as the readers; then pack those components into an in-memory zip and hand it to the reader. The readers use nothing but the components, so the repackaged zip reads exactly as the original document would.

```ts
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as Effect from "effect/Effect";
import { zipSync } from "fflate";
import { blocksToText, bytes } from "@thomasfosterau/effect-document";
import {
  type BundleLimits,
  openBundleDirectory,
} from "@thomasfosterau/effect-document/iwork/codec";
import * as Keynote from "@thomasfosterau/effect-document/iwork/keynote";

const limits: BundleLimits = { maxTotalSize: 64 * 1024 * 1024 };

const program = Effect.gen(function* () {
  // fails with an IworkError (NotIwork, Encrypted, LimitExceeded, Io, …)
  const bundle = yield* openBundleDirectory("Talk.key", { limits });
  // level 0: store the components, don't spend time compressing them again
  const input = bytes(zipSync(bundle.components, { level: 0 }));
  const doc = yield* Keynote.makeKeynoteReader({ limits }).read(input);
  return blocksToText(doc.blocks);
}).pipe(Effect.provide(NodeFileSystem.layer));
```

The same composition works with `makePagesReader` and `makeNumbersReader`, and with `convert` (pass the repackaged `input`). The program requires `FileSystem` (provided above by `@effect/platform-node`; any platform's layer will do), and `zipSync` comes from [`fflate`](https://www.npmjs.com/package/fflate): add it to your own dependencies (this package already depends on it, so a compatible version dedupes). A runnable version is [`examples/read-iwork-directory.ts`](https://github.com/thomasfosterau/effect-document/blob/trunk/examples/read-iwork-directory.ts).

#### Errors

Malformed input fails with the codec's `IworkError`, a `Schema.TaggedError` whose `reason` is one of `NotZip`, `NotIwork` (a zip without `.iwa` components, such as a `.docx`), `LegacyIwork09Unsupported`, `Encrypted`, `LimitExceeded`, `Truncated`, `Malformed` or `Io`, and which names the component, object and byte offset it happened at. The readers wrap it in a `ParseError` whose `reason` repeats the `IworkError`'s reason and location, whose `cause` is the `IworkError`, and whose `code` is `"LimitExceeded"` when a limit was exceeded.

#### The container codec

`@thomasfosterau/effect-document/iwork/codec` exposes the layers the readers use, for working with iWork files directly:

- `openBundle` opens the ZIP bundle and its `.iwa` components, including older documents' nested `Index.zip`; `openBundleDirectory` opens a package saved as a directory (a `.key` folder) through the `FileSystem` service; see [Documents saved as a directory](#documents-saved-as-a-directory) for reading one with the readers.
- `dechunk` / `chunk` handle IWA chunk framing.
- `decompressBlock` / `compressBlock` are Apple's non-standard Snappy block format; the compressor writes literals only, which every Snappy decoder accepts.
- The protobuf wire reader: `parseMessage`, `readVarint` and the field accessors.
- `decodeArchiveStream` decodes archived objects and their messages.
- `readPackageMetadata` reads `Index/Metadata.iwa` (`TSP.PackageMetadata`): the file format version, every component's path and the objects it refers to in other components, and every data file with its path under `Data/` (`None` for the app's own stock images, which the package does not hold).
- `makeObjectResolver` finds an archived object by identifier across components, decoding each component at most once and only when a lookup needs it: the metadata's hints first, then a scan in natural order. `referenceAt` reads the identifier a `TSP.Reference` field names.

`Registry` holds the few reverse-engineered message type ids the readers use; they come from the [keynote-parser](https://github.com/psobot/keynote-parser) v14.4 mapping and can drift between iWork versions.

Test fixtures are vendored from MIT-licensed projects; see `test/fixtures/ATTRIBUTION.md`.

#### API reference

The root entry exports the namespaces `Pages`, `Numbers`, `Keynote` and `Codec`; each subpath exports one of them flat.

##### `@thomasfosterau/effect-document/iwork/pages`

| Export | Kind | Description |
| --- | --- | --- |
| `IworkReaderOptions` | interface | Options shared by the Pages, Numbers and Keynote readers. |
| `pagesFeatures` | const | The features the Pages profile allows, as a list. |
| `Pages` | const | The Pages (read) profile. |
| `PagesFeature` | type | The features the Pages profile allows, as a type. |
| `makePagesReader` | function | Create a Pages Reader. |
| `sniffPages` | const | The Pages sniffer for `detect`: an iWork package whose root is a `TP.DocumentArchive`. |
| `profile` | const | The Pages profile (alias of `Pages`). |
| `format` | const | The Pages format bundle (read-only) for use with `convert`. |
| `PagesReaderTag` | const | The Context tag for the Pages reader, so a program can depend on a Pages reader and have one provided. |
| `PagesReaderLive` | const | A Layer providing the default Pages reader for `PagesReaderTag`. |

##### `@thomasfosterau/effect-document/iwork/numbers`

| Export | Kind | Description |
| --- | --- | --- |
| `IworkReaderOptions` | interface | Options shared by the Pages, Numbers and Keynote readers. |
| `numbersFeatures` | const | The features the Numbers profile allows, as a list. |
| `Numbers` | const | The Numbers (read) profile. |
| `NumbersFeature` | type | The features the Numbers profile allows, as a type. |
| `makeNumbersReader` | function | Create a Numbers Reader (structure only - sheet names, no cell values yet). |
| `sniffNumbers` | const | The Numbers sniffer for `detect`: an iWork package with a Keynote/Numbers root and no slide components. |
| `profile` | const | The Numbers profile (alias of `Numbers`). |
| `format` | const | The Numbers format bundle (read-only, structure only) for use with `convert`. |
| `NumbersReaderTag` | const | The Context tag for the Numbers reader, so a program can depend on a Numbers reader and have one provided. |
| `NumbersReaderLive` | const | A Layer providing the default Numbers reader for `NumbersReaderTag`. |

##### `@thomasfosterau/effect-document/iwork/keynote`

| Export | Kind | Description |
| --- | --- | --- |
| `IworkReaderOptions` | interface | Options shared by the Pages, Numbers and Keynote readers. |
| `keynoteFeatures` | const | The features the Keynote profile allows, as a list. |
| `Keynote` | const | The Keynote (read) profile. |
| `KeynoteFeature` | type | The features the Keynote profile allows, as a type. |
| `makeKeynoteReader` | function | Create a Keynote Reader. |
| `sniffKeynote` | const | The Keynote sniffer for `detect`: an iWork package with slide components. |
| `profile` | const | The Keynote profile (alias of `Keynote`). |
| `format` | const | The Keynote format bundle (read-only) for use with `convert`. |
| `KeynoteReaderTag` | const | The Context tag for the Keynote reader, so a program can depend on a Keynote reader and have one provided. |
| `KeynoteReaderLive` | const | A Layer providing the default Keynote reader for `KeynoteReaderTag`. |

##### `@thomasfosterau/effect-document/iwork/codec`

| Export | Kind | Description |
| --- | --- | --- |
| `codecError` | function | Fail at an offset (a shorthand for the codec's many checks). |
| `fromParseError` | function | Convert an effect-parse error (from a framing grammar) into an `IworkError`. |
| `IworkError` | class | The codec's one failure. |
| `IworkErrorReason` | const | Why the codec failed. |
| `isIworkError` | function | Whether a caught value is the codec's `IworkError`. |
| `shiftOffset` | function | Move an error's offset by `by` bytes (an inner buffer's position in its outer one). |
| `toIworkError` | function | Normalise a caught value. |
| `withLocation` | function | Fill in the component / object an error happened in, keeping any already set. |
| `Registry` | namespace | The handful of reverse-engineered iWork message type ids the readers use. |
| `DecompressOptions` | interface | Options for `decompressBlock`. |
| `DEFAULT_MAX_BLOCK_LENGTH` | const | The default `DecompressOptions.maxLength`. |
| `decompressBlock` | function | Decompress one raw Snappy block. |
| `compressBlock` | function | Compress to a valid raw Snappy block using only literal elements. |
| `WIRE_VARINT` | const | Protobuf wire type 0. |
| `WIRE_I64` | const | Protobuf wire type 1. |
| `WIRE_LEN` | const | Protobuf wire type 2. |
| `WIRE_I32` | const | Protobuf wire type 5. |
| `Field` | interface | One protobuf field record. |
| `varint` | const | A base-128 varint, as a `number` (exact up to 2^53), of at most 10 bytes. |
| `field` | const | One field. |
| `message` | const | A whole message. |
| `VarintRead` | interface | A varint read by `readVarint`. |
| `readVarint` | function | Read a base-128 varint at `pos`, returning the value and the new position. |
| `parseMessage` | function | Parse a message into an ordered list of field records. |
| `getVarint` | function | The first varint/fixed value for a field number, if present. |
| `getBytes` | function | The first length-delimited payload for a field number, if present. |
| `getAllBytes` | function | All length-delimited payloads for a field number (e.g. |
| `getAllVarints` | function | All varint/fixed values for a field number. |
| `getBigInt` | function | The first integer for a field number as an exact `bigint`. |
| `getSint` | function | The first zigzag (`sint32`/`sint64`) varint for a field number. |
| `getDouble` | function | The first `double` (64-bit) for a field number. |
| `getFloat` | function | The first `float` (32-bit) for a field number. |
| `PackedType` | type | How the elements of a repeated scalar field are encoded. |
| `getPacked` | function | All values of a repeated scalar field, whether packed (length-delimited runs) or not (one field per value). |
| `decodeUtf8` | function | Decode a length-delimited payload as a UTF-8 string. |
| `DechunkOptions` | interface | Options for `dechunk`. |
| `DEFAULT_MAX_STREAM_LENGTH` | const | The default `DechunkOptions.maxLength`. |
| `dechunk` | function | Decode an `.iwa` file into its concatenated, decompressed Protobuf stream. |
| `chunk` | function | Encode a Protobuf stream into IWA chunks (64 KiB uncompressed blocks). |
| `IworkMessage` | interface | One archived message. |
| `IworkObject` | interface | One archived object. |
| `decodeArchiveStream` | function | Decode a decompressed object stream into its archived objects. |
| `decodeIwa` | function | Decode an `.iwa` file (dechunk + parse the object stream). |
| `IworkBundle` | interface | An opened iWork document. |
| `BundleLimits` | interface | Zip-bomb limits for opening a bundle; any left out (or `undefined`) take the `DEFAULT_BUNDLE_LIMITS` value. |
| `OpenBundleOptions` | interface | Options for `openBundle` and `openBundleDirectory`. |
| `DEFAULT_BUNDLE_LIMITS` | const | The default `BundleLimits`. |
| `ResolvedBundleLimits` | type | `BundleLimits` with every limit filled in. |
| `openBundle` | function | Open an iWork bundle, inflating only its `.iwa` components. |
| `openBundleDirectory` | function | Open an iWork package saved as a directory (e.g. |
| `compareComponentPaths` | function | Compare paths with their digit runs as numbers, so `Slide-8060.iwa` sorts before `Slide-10000.iwa` and `Slide-8060.iwa` before `Slide-8060-2.iwa`. |
| `ComponentPathOrder` | const | Component paths in natural order, as an `Order` (see `compareComponentPaths`). |
| `componentPaths` | function | The component paths matching a predicate (e.g. |
| `decodeComponent` | function | Decode a single component's archived objects (none if it is absent). |
| `decodeAll` | function | Decode every component's objects, flattened (a whole-document object scan). |
| `METADATA_COMPONENT` | const | `"Index/Metadata.iwa"`, the component holding the package metadata. |
| `PackageMetadata` / `ComponentInfo` / `ComponentReference` / `DataInfo` | interface | What `Index/Metadata.iwa` says about the package, its components and its data files. |
| `readPackageMetadata` | function | A bundle's package metadata; `None` when it has none. |
| `dataInfoOf` | function | The data file with an identifier, if the metadata lists it. |
| `ObjectResolver` | interface | Finds archived objects by identifier across a bundle's components, decoding lazily. |
| `makeObjectResolver` | function | A resolver over a bundle, reading its package metadata first. |
| `referenceAt` | function | The object identifier a `TSP.Reference` field of a message names. |
