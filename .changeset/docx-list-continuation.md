---
"@thomasfosterau/effect-ooxml": patch
---

DOCX: a list item's blocks after its first paragraph (further paragraphs, code blocks, headings, tables) now stay in the item. The writer indents them to the item's level, as Word indents a list's continuation paragraphs, and the reader attaches a paragraph or table indented to an open list's level (from `numbering.xml`, `w:ind` `w:left` or `w:start`) to that list's last item. An item that starts with a code block, table or nested list reads back without the empty numbered paragraph the writer has to put before it.
