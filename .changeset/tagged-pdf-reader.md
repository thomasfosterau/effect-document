---
"@thomasfosterau/effect-pdf": minor
---

The PDF reader reads a tagged PDF from its structure tree (#198, #19): headings at their tagged level, paragraphs, lists (ordered or bulleted by their `/ListNumbering` or their labels), code blocks and block quotes come from the structure elements, through the file's `/RoleMap` (a custom `Heading N` type reads as a heading), and inline styling and links still come from the fonts and annotations. Artifacts (page numbers, running heads) are left out. The reader falls back to inferring structure from the layout when the tree is missing, unreadable, or owns less than 98% of the visible text. `TextGlyph` gains `mcid` and `artifact`. The writer's own output now round-trips heading levels, paragraph and code-block breaks, list-marker-like words, multi-paragraph list items and adjacent lists.
