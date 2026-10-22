---
"@thomasfosterau/effect-pdf": patch
---

PDF reader: one-line paragraphs are no longer merged into one paragraph. The paragraph-break threshold now comes from the line spacing inside paragraphs, so the gaps between paragraphs no longer distort it. Double-spaced text is still read as continuous paragraphs.
