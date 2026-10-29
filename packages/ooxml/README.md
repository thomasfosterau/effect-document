# @thomasfosterau/effect-ooxml

Office Open XML for [`@thomasfosterau/effect-document`](https://www.npmjs.com/package/@thomasfosterau/effect-document): readers and writers for Excel workbooks (`Xlsx`), Word documents (`Docx`) and PowerPoint decks (`Pptx`), implemented directly on SpreadsheetML, WordprocessingML and PresentationML. The only third-party dependency is [fflate](https://www.npmjs.com/package/fflate) for the ZIP container.

> **Experimental.** The API is in flux; expect breaking changes before 1.0.

## Install

```sh
pnpm add effect @thomasfosterau/effect-document @thomasfosterau/effect-ooxml
```

Import the three namespaces from the root, or one format from its subpath (`@thomasfosterau/effect-ooxml/xlsx`, `/docx`, `/pptx`) so a bundler keeps only that one.

## What each format covers

| Format | Profile | Reads and writes |
| --- | --- | --- |
| XLSX | `Spreadsheet` (from `effect-document/profiles`) | every worksheet; shared and inline strings, numbers, booleans, errors and formulas. Dates are written as ISO-8601 text and read back as text; styles are not read or written yet. |
| DOCX | `Docx` | paragraphs, headings (`Heading1`–`Heading6`, with a bookmark around the whole heading as its id), bookmarked text as a `Span` with the bookmark as its id, runs with bold / italic / underline / strikeout / superscript / subscript / small caps, hyperlinks (a `#name` link goes to the bookmark `name`), bullet and ordered lists, tables. |
| PPTX | `Pptx` | slides of text boxes and placeholders holding paragraphs, headings and bullet / numbered lists. No pictures or speaker notes yet. |

## Usage

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
import { Docx, Xlsx } from "@thomasfosterau/effect-ooxml";

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

## API reference

The root entry exports the three namespaces `Xlsx`, `Docx` and `Pptx`; each subpath exports one of them flat.

### `@thomasfosterau/effect-ooxml/xlsx`

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
| `XlsxReaderTag` | const | Context tag for dependency-injection style usage. |
| `XlsxReaderLive` | const | Layer providing an XLSX Reader with default options. |
| `makeXlsxReaderLayer` | function | Layer providing an XLSX Reader with custom options. |
| `sanitizeSheetNames` | function | Make sheet names Excel accepts, deterministically. |
| `XlsxWriterOptions` | interface | Options for the XLSX writer. |
| `makeXlsxWriter` | function | Create an XLSX Writer with the given options baked in. |
| `XlsxWriterTag` | const | Context tag for dependency-injection style usage. |
| `XlsxWriterLive` | const | Layer providing an XLSX Writer with default options. |
| `makeXlsxWriterLayer` | function | Layer providing an XLSX Writer with custom options. |

### `@thomasfosterau/effect-ooxml/docx`

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
| `DocxReaderTag` | const | The Context tag for the DOCX reader, so a program can depend on a DOCX reader and have one provided. |
| `DocxReaderLive` | const | A Layer providing the default DOCX reader for `DocxReaderTag`. |
| `DocxWriterOptions` | interface | Options for the DOCX writer. |
| `makeDocxWriter` | function | Create a DOCX Writer. |
| `DocxWriterTag` | const | The Context tag for the DOCX writer, so a program can depend on a DOCX writer and have one provided. |
| `DocxWriterLive` | const | A Layer providing the default DOCX writer for `DocxWriterTag`. |

### `@thomasfosterau/effect-ooxml/pptx`

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
| `PptxReaderTag` | const | The Context tag for the PPTX reader, so a program can depend on a PPTX reader and have one provided. |
| `PptxReaderLive` | const | A Layer providing the default PPTX reader for `PptxReaderTag`. |
| `PptxWriterOptions` | interface | Options for the PPTX writer. |
| `makePptxWriter` | function | Create a PPTX Writer. |
| `PptxWriterTag` | const | The Context tag for the PPTX writer, so a program can depend on a PPTX writer and have one provided. |
| `PptxWriterLive` | const | A Layer providing the default PPTX writer for `PptxWriterTag`. |
