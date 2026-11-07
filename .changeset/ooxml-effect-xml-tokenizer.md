---
"@thomasfosterau/effect-document": minor
---

The OOXML readers (`/ooxml`, `/ooxml/xlsx`, `/ooxml/docx`, `/ooxml/pptx`) now tokenize XML with [`@thomasfosterau/effect-xml`](https://www.npmjs.com/package/@thomasfosterau/effect-xml) (#141), a new optional peer (`^0.1.0`) to install beside `@thomasfosterau/effect-parse` when you use them. The trees the readers build are unchanged (namespaces resolved, `mc:AlternateContent` resolved, the XLSX `sheetData` row scanner kept), and a malformed part's `ParseError` is still positioned, its `cause` (the `XmlPartError`) now carrying effect-xml's tagged error (`InvalidEntity`, `UnexpectedCharacter`, …) as its own `cause`.

Parsing is stricter where XML requires it: a reference to an entity other than the five predefined ones, a character reference to a code point XML does not allow, and a raw character XML forbids (a C0 control character, say) now fail the part, where they were read as written, as U+FFFD or as themselves before. Line ends are normalized (a carriage return in text reads as a line feed) and attribute values are normalized (a literal tab, line feed or carriage return reads as a space), as XML requires. `parseXmlResult` and `parseXml` on `/ooxml/xlsx` follow suit, and keep their signatures.
