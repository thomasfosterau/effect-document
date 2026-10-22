---
"@thomasfosterau/effect-ooxml": patch
---

DOCX correctness fixes.

Writer:

- Hyperlink targets are attribute-escaped.
- Each ordered list gets its own numbering instance, honouring `start`.
- Nested lists and other blocks inside list items are kept.
- `Quoted` gets its quotation marks.
- `\n` and `\t` become `w:br` and `w:tab`.
- A `styles.xml` part defines Heading1–6, Code and TableGrid.
- `#anchor` links are written as internal hyperlinks.

Reader:

- ST_OnOff "off" values and `w:u="none"` are honoured.
- `numId="0"` is not a list item.
- List kinds, nesting and start numbers come from `numbering.xml` and `w:ilvl`.
- Text in tracked insertions and content controls is kept, and deleted text is dropped.
- Simple and complex `HYPERLINK` fields become links.
- `w:anchor` becomes `#anchor`.
- A page break ends the paragraph.
- Code-styled paragraphs read back as code blocks.
