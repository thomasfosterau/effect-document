---
"@thomasfosterau/effect-document": minor
---

feat: constructors for every remaining node (#125). Inlines: `space`, `softBreak`, `lineBreak`, `underline`, `strikeout`, `superscript`, `subscript`, `smallCaps`, `quoted`, `code`, `math`, `rawInline`, `image`, `note`, `span`. Blocks: `blockQuote`, `div`, `figure`, `definitionList`, `lineBlock`, `horizontalRule`, `rawBlock`. Shapes: `picture`, `placeholder`. Also `textInlines`, which splits text into `Str` / `Space` / `SoftBreak` runs as Pandoc's `text` builder does, and `normalizeInlines`.
