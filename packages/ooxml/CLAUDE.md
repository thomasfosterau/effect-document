# @thomasfosterau/effect-ooxml (packages/ooxml)

Office Open XML: `src/xlsx` (SpreadsheetML; the core `Spreadsheet` profile), `src/docx` (WordprocessingML; its own `Docx` profile), `src/pptx` (PresentationML; its own `Pptx` profile), over `src/shared` (the effect-parse XML parser and writer helpers in `xml.ts`, the OPC package reader / ZIP writer in `opc.ts`, and the mapping of package failures to `ParseError` in `errors.ts`, and the grouping of list paragraphs into nested lists that the DOCX and PPTX readers share in `lists.ts`).

## Boundary

Peers: `effect`; dependencies `@thomasfosterau/effect-document`, `@thomasfosterau/effect-parse` and `fflate` (ZIP). `.fallowrc.json` zone `ooxml` may import `core` only. Each format is its own entry (`./xlsx`, `./docx`, `./pptx`) and imports only `shared`, never another format, so a consumer's bundler keeps one format without the others.

## Invariants

- **Each format reads and writes exactly its profile.** XLSX dates are written as ISO-8601 shared strings and read back as text (no date serials or styles yet); a feature the writer cannot encode is excluded from the profile, never silently dropped at write time.
- **Packages are read through relationships, not fixed paths**: the main part is found from `_rels/.rels` (`officeDocument`), with the conventional path as the fallback; a missing part is an `OpcError` of kind `MissingPart`, surfaced as the `ParseError`'s `cause` (`ooxmlParseError` in `shared/errors.ts` maps every package failure).
- **Lists**: DOCX list paragraphs are recognised by numbering (`word/numbering.xml` decides bullet or ordered per `numId` and level; without it, `numId` 2 is the ordered list the writer emits), PPTX ones by `buChar` / `buAutoNum`; consecutive items at deeper levels nest inside the item before them. A DOCX item's blocks after its first paragraph are written indented to the item's level (`w:ind` / `w:tblInd`, the numbering level's indent), and a paragraph or table indented to an open list's level is read back into that list's last item (#195). A PPTX item's later paragraphs are written unbulleted at its level's `marL` and read back into the item; an ordered item with `buAutoNum@startAt` begins a new list (#196).
- **Writers are byte-reproducible**: every ZIP entry carries the fixed `ZIP_MTIME` (1980-01-01), so the same document always writes the same bytes.
