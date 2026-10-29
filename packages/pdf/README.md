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

**Reading** recovers prose from the page layout: headings (ranked by font size), paragraphs (including ones broken across pages), bullet/ordered/nested lists, code blocks (runs of monospaced lines, indentation kept), bold, italic, inline code and links (from link annotations), plus the document information dictionary as metadata. A tagged PDF (one with a structure tree, as Word, LibreOffice, Chrome and this package's writer produce) is read from its tags instead: headings at their tagged level, paragraphs, lists (ordered or bulleted by their numbering or labels), code blocks and block quotes come from the structure elements, through the file's `/RoleMap`, and only the inline styling still comes from the fonts. The reader falls back to the layout when the tree is missing, unreadable, or owns less than 98% of the visible text. It handles simple and composite (Type 0) fonts, `/ToUnicode` CMaps, standard and custom encodings, `/ActualText`, Form XObjects and rotated pages. Damaged files are repaired by scanning for objects. Encrypted files are refused.

**Scanned pages** (images with no text layer) read as empty unless you give the reader an OCR engine. Either way, the pages left without text are listed in the document's `pagesWithoutText` metadata (1-based page numbers). No engine is bundled: implement `OcrEngineShape` over the one you use (Tesseract.js, a cloud OCR API, …) and pass it as `ocr`, or provide it as the `OcrEngine` service and use `PdfOcrReaderLive`:

```ts
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Pdf from "@thomasfosterau/effect-pdf";

declare const myEngine: Pdf.OcrEngineShape; // recognize(image) => Effect<ReadonlyArray<OcrWord>, OcrError>

const reader = Pdf.makePdfReader({ ocr: myEngine });
// or, as a service:
const ReaderLive = Pdf.PdfOcrReaderLive.pipe(Layer.provide(Layer.succeed(Pdf.OcrEngine, myEngine)));
```

The engine is called once for each image a textless page paints, in painting order, and never for pages that have text. It gets the image as the PDF stores it. JPEG, JPEG 2000, CCITT fax and JBIG2 data arrive still encoded (`_tag: "Encoded"`, with the codec's `parameters` and any JBIG2 `globals`). Other images arrive as decoded gray, RGB or CMYK samples (`_tag: "Samples"`). Images in other colour spaces (indexed, separation, …) are skipped. The engine returns words with pixel boxes (origin at the top-left), which the reader places on the page and lays out like any other text. An `OcrError` fails the read with a `ParseError` naming the page.

**Writing** typesets a document onto pages (headings are bold, so `PdfWrite` keeps `Strong` out of headings, and `convert` unwraps it there with a loss entry): word-wrapped paragraphs, headings, nested lists, code blocks, block quotes, rules, bold/italic/underline/strikeout, inline code and clickable links. It uses the standard 14 fonts (Helvetica, Courier) with WinAnsiEncoding, so nothing is embedded; characters outside WinAnsiEncoding are written as `?`.

The output is a tagged PDF: a structure tree (`/StructTreeRoot`) records each heading (`H1`–`H6`), paragraph (`P`), list (`L` / `LI` / `Lbl` / `LBody`, with its numbering), code block (`Code`), block quote and link, and marks the text each owns, so screen readers and other tools see the document's structure; rules, underlines and quote bars are marked as artifacts. A document's `lang` metadata becomes the catalog's `/Lang`.

The object layer is on its own subpath, for working with PDF structure directly:

```ts
import { PdfFile, rewritePdf } from "@thomasfosterau/effect-pdf/cos";

declare const data: Uint8Array;
const file = PdfFile.open(data); // xref tables and streams, object streams, incremental updates, repair
file.pages().length;
file.lookupDict(file.catalog, "Pages");
const saved = rewritePdf(file); // re-serialize (optionally with replaced objects)
```

The object layer is synchronous and throws: `PdfSyntaxError` (with the byte `offset`, and `code: "LimitExceeded"` when arrays and dictionaries nest deeper than `MAX_OBJECT_NESTING`), `PdfFilterError` (with the `filter`) and `PdfEncryptedError`. The reader and writer turn those into a `ParseError` / `WriteError` in the error channel.

## API reference

### `@thomasfosterau/effect-pdf`

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
