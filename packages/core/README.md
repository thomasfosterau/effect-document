# @thomasfosterau/effect-document

A type-safe, profile-based universal document schema for [Effect](https://effect.website) 4. One Pandoc-style AST spans prose documents, spreadsheets and presentations; **profiles** carve out named subsets of it; and the type system tracks which subset a document belongs to, so a reader returns exactly what its format produces, a writer accepts only what its format can represent, and converting between formats reports precisely what was lost.

This package holds the schema, the profiles and the `Reader` / `Writer` / `Format` / `convert` pipeline. Each file format is its own package: [`effect-csv`](https://www.npmjs.com/package/@thomasfosterau/effect-csv), [`effect-ooxml`](https://www.npmjs.com/package/@thomasfosterau/effect-ooxml) (XLSX, DOCX, PPTX), [`effect-rtf`](https://www.npmjs.com/package/@thomasfosterau/effect-rtf), [`effect-pdf`](https://www.npmjs.com/package/@thomasfosterau/effect-pdf) and [`effect-iwork`](https://www.npmjs.com/package/@thomasfosterau/effect-iwork).

> **Experimental.** The API is in flux; expect breaking changes before 1.0.

## Install

```sh
pnpm add effect @thomasfosterau/effect-document
```

`effect` (4.x, `>=4.0.0-rc.118`) is a peer dependency: your application owns the single copy.

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

The vocabulary is a Pandoc superset: the full inline and block set (emphasis, links, images, code, math, notes, lists, block quotes, figures, divs, tables), a spreadsheet model (`Worksheet` with typed `CellText` / `CellNumber` / `CellBoolean` / `CellDate` / `CellError` / `CellBlank` / `CellFormula` / `CellRichText`, merges and columns) (a worksheet is sparse: it holds indexed rows of column-indexed cells, and `denseRows` derives the grid, within a cell budget), and a presentation model (`SlideShow` → `Slide` → shapes and speaker notes). Most nodes carry an optional `attr`: an `id`, `classes`, a structured `style` and an open `data` map for format-specific attributes.

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
import * as Csv from "@thomasfosterau/effect-csv";
import { Xlsx } from "@thomasfosterau/effect-ooxml";

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

Failures are tagged errors in the error channel: `ParseError` (with the format and, where known, a source position), `WriteError`, `ProfileViolation` and `ConversionError` (a format with no reader or writer). Every reader and writer is also available as a Context tag with a default `Layer` (`CsvReaderTag` / `CsvReaderLive`, …) for programs that inject them.

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
| `Feature` | type | Any capability the universal document schema can express. |
| `TAG_FEATURE` | const | Maps a node's `_tag` to the feature it represents. |
| `TaggedNode` | type | Any document node whose tag `TAG_FEATURE` maps to a feature. |
| `featureOfTag` | function | The feature represented by a node's tag, if the tag is mapped. |
| `ALL_INLINE_FEATURES` | const | Every inline feature, for assembling profiles. |
| `ALL_BLOCK_FEATURES` | const | Every prose block feature, for assembling profiles. |
| `ALL_SHEET_FEATURES` | const | Every spreadsheet feature (worksheets and cell types), for assembling profiles. |
| `ALL_DECK_FEATURES` | const | Every presentation feature (slide shows and shapes), for assembling profiles. |
| `ALL_ATTR_FEATURES` | const | Every attribute facet feature, for assembling profiles. |
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
| `IndexedCell` | class | A cell at its 0-based column. |
| `SheetRow` | class | A spreadsheet row: its 0-based `index` and the cells it holds, in ascending column order. |
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
| `sheetRow` | function | A sparse row from a dense array of cells. |
| `NestedNode` | type | A node that counts as one level of nesting. |
| `DEFAULT_MAX_NESTING_DEPTH` | const | The default maximum nesting depth readers accept. |
| `nestedChildren` | function | The blocks, inlines and shapes directly inside a node. |
| `blocksNestingDepth` | function | The deepest chain of nested blocks, inlines and shapes in `blocks`. |
| `nestingDepth` | function | The nesting depth of a document's blocks; see `blocksNestingDepth`. |

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
| `Format` | interface | A format bundle for `convert`. |
| `AnyFormat` | type | A `Format` for some (existentially-quantified) profiles. |
| `ConvertOptions` | interface | Options for `convert`. |
| `ConvertResult` | interface | The rendered target content and what was lost getting there. |
| `ConvertError` | type | Every way `convert` can fail. |
| `convert` | function | Convert content from one format to another. |

Every node class also has a `*Encoded` interface: its JSON form (`ParaEncoded`, `WorksheetEncoded`, …), which is what `Schema.encode` produces.
