---
"@thomasfosterau/effect-document": minor
---

Add DOCX (Word), PPTX (PowerPoint) and RTF formats, each with its own profile.

- **DOCX** (WordprocessingML): reads/writes headings, runs (bold/italic/
  underline/strike/super/sub/small-caps), hyperlinks, bullet/ordered lists and
  tables.
- **PPTX** (PresentationML): reads/writes a structurally valid deck of slides
  whose text-box / placeholder shapes hold paragraphs, headings and lists.
- **RTF**: reads/writes paragraphs and headings with bold/italic/underline/
  strike runs.

Each format defines its own subset profile (`Docx`, `Pptx`, `Rtf`), so they
exercise the conversion machinery across document families: `Rtf → Docx` widens
for free, while `Docx → Rtf` and `Pptx → Docx`/`Rtf` narrow with a loss report
(links to text, lists to paragraphs, slides flattened to prose, tables dropped).

Internally, the OOXML XML parser and a new OPC packaging helper are shared
across xlsx/docx/pptx under `src/formats/ooxml/`. The XLSX reader now also
round-trips formula cells.
