---
"@thomasfosterau/effect-pdf": minor
---

Add `@thomasfosterau/effect-pdf`: a PDF reader and writer with its own profile
(`Pdf`), built on a dependency-light PDF object layer.

- **Reading** extracts each page's positioned text (simple and Type 0 fonts,
  `/ToUnicode` CMaps, standard encodings and `/Differences`, `/ActualText`,
  Form XObjects, rotated pages) and infers prose from the layout: headings
  ranked by font size, paragraphs (joined across page breaks), bullet/ordered/
  nested lists, code blocks, bold, italic, inline code, and links from link
  annotations. The document information dictionary becomes the metadata.
  Encrypted files are refused.
- **Writing** typesets headings, word-wrapped paragraphs, nested lists, code
  blocks, block quotes, rules, bold/italic/underline/strikeout, inline code
  and clickable links onto A4/Letter/custom pages with the standard 14 fonts
  (WinAnsi characters only).
- **`@thomasfosterau/effect-pdf/cos`**, the object layer: the object model, a
  lenient parser, stream filters (Flate with predictors, LZW, ASCIIHex,
  ASCII85, RunLength), `PdfFile` for opening files (xref tables and streams,
  object streams, incremental updates, and repair of damaged files),
  content-stream tokenizing, and `PdfBuilder` / `rewritePdf` for writing.
