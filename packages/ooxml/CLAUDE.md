# @thomasfosterau/effect-ooxml (packages/ooxml)

Office Open XML: `src/xlsx` (SpreadsheetML; the core `Spreadsheet` profile), `src/docx` (WordprocessingML; its own `Docx` profile), `src/pptx` (PresentationML; its own `Pptx` profile), over `src/shared` (the effect-parse XML parser and writer helpers in `xml.ts`, the OPC package reader / ZIP writer in `opc.ts`, and the run / list helpers DOCX and PPTX share in `runs.ts`).

## Boundary

Peers: `effect`; dependencies `@thomasfosterau/effect-document`, `@thomasfosterau/effect-parse` and `fflate` (ZIP). `.fallowrc.json` zone `ooxml` may import `core` only. Each format is its own entry (`./xlsx`, `./docx`, `./pptx`) and imports only `shared`, never another format, so a consumer's bundler keeps one format without the others.

## Invariants

- **Each format reads and writes exactly its profile.** XLSX dates are written as ISO-8601 shared strings and read back as text (no date serials or styles yet); a feature the writer cannot encode is excluded from the profile, never silently dropped at write time.
- **Packages are read through relationships, not fixed paths**: the main part is found from `_rels/.rels` (`officeDocument`), with the conventional path as the fallback; a missing main part is a `MissingPartError`, surfaced as the `ParseError`'s `cause`.
- **Run formatting is shared**: readers wrap text in marks through `wrapRun` (small caps, vertical alignment, emphasis, strong, underline, strikeout, innermost first) and writers walk marks back into runs through `renderRuns`; DOCX renders the extra marks (superscript, subscript, small caps, code, quotes, hyperlinks) through its `other` hook, PPTX drops them (its profile excludes them).
- **Lists**: DOCX list paragraphs are recognised by numbering (`numId` 2 is the ordered list the writer emits), PPTX ones by `buChar` / `buAutoNum`; consecutive items group into one list through `makeListGrouper`.
- **Writers are not byte-reproducible**: fflate stamps each ZIP entry with the current time, so compare written packages by reading them back, never byte for byte.
