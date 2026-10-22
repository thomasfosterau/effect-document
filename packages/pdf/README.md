# @thomasfosterau/effect-pdf

PDF for [`@thomasfosterau/effect-document`](https://www.npmjs.com/package/@thomasfosterau/effect-document): a reader and writer for the `Pdf` profile, on top of a self-contained PDF object layer (`./cos`). The only third-party dependency is [fflate](https://www.npmjs.com/package/fflate), for `/FlateDecode`.

> **Experimental.** The API is in flux; expect breaking changes before 1.0.

## Install

```sh
pnpm add effect @thomasfosterau/effect-document @thomasfosterau/effect-pdf
```

## Usage

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
import * as Pdf from "@thomasfosterau/effect-pdf";

const program = Effect.gen(function* () {
  const doc = trustAs<Pdf.PdfFeature>(
    document([header(1, [str("Title")]), para([str("Body text.")])]),
  );
  const pdf = yield* Pdf.makePdfWriter({ pageSize: "letter" }).write(doc); // Bytes
  const back = yield* Pdf.makePdfReader().read(pdf); // Doc<PdfFeature>
  return blocksToText(back.blocks); // "Title\nBody text."
});
```

**Reading** recovers prose from the page layout: headings (ranked by font size), paragraphs (including ones broken across pages), bullet/ordered/nested lists, code blocks (runs of monospaced lines, indentation kept), bold, italic, inline code and links (from link annotations), plus the document information dictionary as metadata. It handles simple and composite (Type 0) fonts, `/ToUnicode` CMaps, standard and custom encodings, `/ActualText`, Form XObjects and rotated pages. Damaged files are repaired by scanning for objects. Encrypted files are refused, and there is no OCR for scanned pages.

**Writing** typesets a document onto pages: word-wrapped paragraphs, headings, nested lists, code blocks, block quotes, rules, bold/italic/underline/strikeout, inline code and clickable links. It uses the standard 14 fonts (Helvetica, Courier) with WinAnsiEncoding, so nothing is embedded; characters outside WinAnsiEncoding are written as `?`.

The object layer is on its own subpath, for working with PDF structure directly:

```ts
import { PdfFile, rewritePdf } from "@thomasfosterau/effect-pdf/cos";

declare const data: Uint8Array;
const file = PdfFile.open(data); // xref tables and streams, object streams, incremental updates, repair
file.pages().length;
file.lookupDict(file.catalog, "Pages");
const saved = rewritePdf(file); // re-serialize (optionally with replaced objects)
```

The object layer is synchronous and throws: `PdfSyntaxError` (with the byte `offset`), `PdfFilterError` (with the `filter`) and `PdfEncryptedError`. The reader and writer turn those into a `ParseError` / `WriteError` in the error channel.

## API reference

### `@thomasfosterau/effect-pdf`

| Export | Kind | Description |
| --- | --- | --- |
| `decodeTextString` | function | Decode a text string. |
| `glyphToUnicode` | function | The Unicode text for a glyph name. |
| `PageLink` | interface | A URI link annotation. |
| `PageText` | interface | A page's positioned text and links. |
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
| `PdfReaderOptions` | interface | Options for the PDF reader. |
| `makePdfReader` | function | Create a PDF Reader. |
| `PdfReaderTag` | const | The Context tag for the PDF reader, so a program can depend on a PDF reader and have one provided. |
| `PdfReaderLive` | const | A Layer providing the default PDF reader for `PdfReaderTag`. |
| `PAGE_SIZES` | const | Page sizes in points. |
| `PdfWriterOptions` | interface | Options for the PDF writer. |
| `renderPdf` | function | Render a PDF-profile document to PDF bytes. |
| `makePdfWriter` | function | Create a PDF Writer. |
| `PdfWriterTag` | const | The Context tag for the PDF writer, so a program can depend on a PDF writer and have one provided. |
| `PdfWriterLive` | const | A Layer providing the default PDF writer for `PdfWriterTag`. |

### `@thomasfosterau/effect-pdf/cos`

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
