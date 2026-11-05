---
"@thomasfosterau/effect-ooxml": patch
"@thomasfosterau/effect-pdf": patch
"@thomasfosterau/effect-rtf": patch
---

Faster readers (see `vp run bench:<format>`): XLSX builds its rows with `sparseRow` and the shared XML parser no longer allocates per element to check attribute names and namespace declarations (about 25% faster). The PDF reader's per-glyph matrix arithmetic and layout run without per-glyph arrays and regular expressions (reading 200 pages: about 0.58 s → 0.31 s, now level with pdf.js's text extraction); its output is unchanged. The DOCX, PPTX, RTF and PDF readers build text runs with the faster `str`.
