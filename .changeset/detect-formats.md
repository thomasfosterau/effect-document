---
"@thomasfosterau/effect-document": minor
---

Format detection for import (#188). `detect(content, { formats, hints })` ranks the formats some content may be, each candidate with a `confidence` and an `evidence` string, and never fails. A format's optional `sniff` judges the content alone. Its `extensions` and `mimeTypes` (also new, also optional on `Format`) only break ties between equally sure sniffers. Every bundled format now has a sniffer: CSV, TSV, XLSX, DOCX, PPTX, PDF, RTF, Pages, Numbers and Keynote (`sniffCsv`, `sniffXlsx`, …). `candidateTables(doc)` lists a document's tabular regions: every worksheet, prose table and slide table shape, wherever it sits. Each comes with a locator, its name or caption, its size and a header guess, and a prose table also comes as a text grid with its merged cells listed.
