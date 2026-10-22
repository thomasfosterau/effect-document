# @thomasfosterau/effect-pdf (packages/pdf)

PDF for its own `Pdf` profile. Three layers: the object layer `src/cos` (the object model, a lenient lexer / parser, stream filters, `PdfFile` with xref tables and streams, object streams, incremental updates and repair, `PdfBuilder` / `rewritePdf`), text extraction `src/text` (fonts, encodings, CMaps, the content-stream interpreter, and layout inference into blocks), and the reader / writer on top.

## Boundary

Peers: `effect`; dependencies `@thomasfosterau/effect-document` and `fflate` (Flate). `.fallowrc.json` zone `pdf` may import `core` only. `src/cos` imports nothing from `src/text` or the reader / writer: it is published as its own entry (`./cos`) for working with PDF structure directly.

## Invariants

- **The object layer is synchronous and throws its own tagged errors** (`PdfSyntaxError` with the byte offset, `PdfFilterError` with the filter, `PdfEncryptedError`); only the reader and writer turn failures into a `ParseError` / `WriteError` in the error channel.
- **Malformed input is repaired, not trusted.** A broken cross-reference chain triggers a scan of the whole file (`rebuild`), an unreadable object, object-stream member, trailer or Form XObject is skipped, and recursion is bounded (page tree depth 64, Form XObjects 12 deep, reference cycles through `/Length` guarded). Encrypted files are refused.
- **The reader infers structure from layout only**: the most common font size is body text, larger sizes rank as heading levels, gaps wider than the usual leading split paragraphs, a leading bullet or number makes a list item, runs of monospaced lines are code; `/ActualText` replaces the glyphs it spans.
- **The writer embeds nothing**: the standard 14 fonts with WinAnsiEncoding; a character outside it is written as `?`.
- **`PdfDict.entries` is a public native `Map`** in the object model (callers read it, iterate it in insertion order and pass their own); changing it is an API change (#155).
- **`src/text/data.ts` is generated** (base encodings, a subset of the Adobe Glyph List, the standard 14 font widths) by `scripts/generate-data.py` from the copies bundled with ReportLab; edit the script, not the file. The fixtures in `test/fixtures` record their provenance in its README.
