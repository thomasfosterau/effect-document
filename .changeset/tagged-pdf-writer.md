---
"@thomasfosterau/effect-pdf": minor
---

The PDF writer now produces tagged PDF (#198): a structure tree with headings (`H1`–`H6`), paragraphs, lists (`L` / `LI` / `Lbl` / `LBody`, with their numbering), code blocks, block quotes and links, each owning the marked content it sets, with a parent tree for the content and the link annotations, and `/MarkInfo << /Marked true >>`. Rules, underlines and quote bars are marked as artifacts, and a document's `lang` metadata becomes the catalog's `/Lang`. Screen readers and other tools see the document's structure; the reader does not use the tags yet.
