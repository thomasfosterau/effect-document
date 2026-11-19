# Formats

Each format family is a subpath of this package, kept off the root barrel. `/csv`, `/rtf`, `/ooxml*` and `/iwork*` are written on [`@thomasfosterau/effect-parse`](https://www.npmjs.com/package/@thomasfosterau/effect-parse), an optional peer you install to use them; `/ooxml*`, `/pdf*` and `/iwork*` load [fflate](https://www.npmjs.com/package/fflate) (ZIP and DEFLATE), a dependency. The root entry, `/schema`, `/profile`, `/profiles` and `/io` load neither.

## Feature support

<!-- feature-matrix:start -->

Generated from each format's read and write profiles by `test/integration/feature-matrix.test.ts`; `R` is read, `W` written, `*` on some kinds of node only (an id on a heading, but not on every node), `–` neither.

| Feature                | CSV | TSV | XLSX | DOCX | PPTX | RTF | PDF | Keynote | Pages | Numbers |
| ---------------------- | :-: | :-: | :--: | :--: | :--: | :-: | :-: | :-----: | :---: | :-----: |
| `inline.str`           |  –  |  –  |  RW  |  RW  |  RW  | RW  | RW  |    R    |   R   |    –    |
| `inline.space`         |  –  |  –  |  RW  |  RW  |  RW  | RW  | RW  |    R    |   R   |    –    |
| `inline.softBreak`     |  –  |  –  |  RW  |  RW  |  RW  | RW  | RW  |    R    |   R   |    –    |
| `inline.lineBreak`     |  –  |  –  |  –   |  RW  |  RW  | RW  |  R  |    R    |   R   |    –    |
| `inline.emph`          |  –  |  –  |  RW  |  RW  |  RW  | RW  | RW  |    –    |   –   |    –    |
| `inline.strong`        |  –  |  –  |  RW  |  RW  |  RW  | RW  | RW  |    –    |   –   |    –    |
| `inline.underline`     |  –  |  –  |  RW  |  RW  |  RW  | RW  |  R  |    –    |   –   |    –    |
| `inline.strikeout`     |  –  |  –  |  RW  |  RW  |  RW  | RW  |  R  |    –    |   –   |    –    |
| `inline.superscript`   |  –  |  –  |  RW  |  RW  |  –   |  –  |  –  |    –    |   –   |    –    |
| `inline.subscript`     |  –  |  –  |  RW  |  RW  |  –   |  –  |  –  |    –    |   –   |    –    |
| `inline.smallCaps`     |  –  |  –  |  –   |  RW  |  –   |  –  |  –  |    –    |   –   |    –    |
| `inline.quoted`        |  –  |  –  |  –   |  –   |  –   |  –  |  –  |    –    |   –   |    –    |
| `inline.cite`          |  –  |  –  |  –   |  –   |  –   |  –  |  –  |    –    |   –   |    –    |
| `inline.code`          |  –  |  –  |  –   |  –   |  –   |  –  | RW  |    –    |   –   |    –    |
| `inline.math`          |  –  |  –  |  –   |  –   |  –   |  –  |  –  |    –    |   –   |    –    |
| `inline.rawInline`     |  –  |  –  |  –   |  –   |  –   |  –  |  –  |    –    |   –   |    –    |
| `inline.link`          |  –  |  –  |  RW  |  RW  |  –   |  –  | RW  |    –    |   –   |    –    |
| `inline.image`         |  –  |  –  |  –   |  –   |  –   |  –  |  –  |    –    |   –   |    –    |
| `inline.note`          |  –  |  –  |  –   |  –   |  –   |  –  |  –  |    –    |   –   |    –    |
| `inline.span`          |  –  |  –  |  –   |  RW  |  –   |  –  |  –  |    –    |   –   |    –    |
| `block.plain`          |  –  |  –  |  –   |  RW  |  RW  | RW  | RW  |    R    |   R   |    –    |
| `block.para`           |  –  |  –  |  RW  |  RW  |  RW  | RW  | RW  |    R    |   R   |    –    |
| `block.lineBlock`      |  –  |  –  |  –   |  –   |  –   |  –  |  –  |    –    |   –   |    –    |
| `block.codeBlock`      |  –  |  –  |  –   |  RW  |  –   |  –  | RW  |    –    |   –   |    –    |
| `block.rawBlock`       |  –  |  –  |  –   |  –   |  –   |  –  |  –  |    –    |   –   |    –    |
| `block.blockQuote`     |  –  |  –  |  –   |  –   |  –   |  –  |  R  |    –    |   –   |    –    |
| `block.orderedList`    |  –  |  –  |  –   |  RW  |  RW  |  –  | RW  |    –    |   –   |    –    |
| `block.bulletList`     |  –  |  –  |  –   |  RW  |  RW  |  –  | RW  |    –    |   –   |    –    |
| `block.definitionList` |  –  |  –  |  –   |  –   |  –   |  –  |  –  |    –    |   –   |    –    |
| `block.header`         |  –  |  –  |  –   |  RW  |  RW  | RW  | RW  |    –    |   –   |    –    |
| `block.horizontalRule` |  –  |  –  |  –   |  –   |  –   |  –  |  R  |    –    |   –   |    –    |
| `block.figure`         |  –  |  –  |  –   |  –   |  –   |  –  |  –  |    –    |   –   |    –    |
| `block.div`            |  –  |  –  |  –   |  –   |  –   |  –  |  –  |    –    |   –   |    –    |
| `block.table`          |  –  |  –  |  –   |  RW  |  –   |  –  |  –  |    –    |   –   |    –    |
| `sheet.worksheet`      | RW  | RW  |  RW  |  –   |  –   |  –  |  –  |    –    |   –   |    R    |
| `sheet.multiple`       |  –  |  –  |  RW  |  –   |  –   |  –  |  –  |    –    |   –   |    R    |
| `sheet.merges`         |  –  |  –  |  RW  |  –   |  –   |  –  |  –  |    –    |   –   |    –    |
| `sheet.columns`        |  –  |  –  |  RW  |  –   |  –   |  –  |  –  |    –    |   –   |    –    |
| `sheet.hidden`         |  –  |  –  |  RW  |  –   |  –   |  –  |  –  |    –    |   –   |    –    |
| `cell.text`            | RW  | RW  |  RW  |  –   |  –   |  –  |  –  |    –    |   –   |    R    |
| `cell.number`          | RW  | RW  |  RW  |  –   |  –   |  –  |  –  |    –    |   –   |    R    |
| `cell.boolean`         | RW  | RW  |  RW  |  –   |  –   |  –  |  –  |    –    |   –   |    R    |
| `cell.date`            |  –  |  –  |  R   |  –   |  –   |  –  |  –  |    –    |   –   |    –    |
| `cell.error`           |  –  |  –  |  RW  |  –   |  –   |  –  |  –  |    –    |   –   |    –    |
| `cell.blank`           | RW  | RW  |  RW  |  –   |  –   |  –  |  –  |    –    |   –   |    R    |
| `cell.formula`         |  –  |  –  |  RW  |  –   |  –   |  –  |  –  |    –    |   –   |    –    |
| `cell.richText`        |  –  |  –  |  RW  |  –   |  –   |  –  |  –  |    –    |   –   |    –    |
| `cell.style`           |  –  |  –  |  –   |  –   |  –   |  –  |  –  |    –    |   –   |    –    |
| `deck.slideShow`       |  –  |  –  |  –   |  –   |  RW  |  –  |  –  |    R    |   –   |    –    |
| `deck.notes`           |  –  |  –  |  –   |  –   |  –   |  –  |  –  |    –    |   –   |    –    |
| `deck.layout`          |  –  |  –  |  –   |  –   |  R   |  –  |  –  |    –    |   –   |    –    |
| `shape.textBox`        |  –  |  –  |  –   |  –   |  RW  |  –  |  –  |    R    |   –   |    –    |
| `shape.picture`        |  –  |  –  |  –   |  –   |  –   |  –  |  –  |    –    |   –   |    –    |
| `shape.table`          |  –  |  –  |  –   |  –   |  –   |  –  |  –  |    –    |   –   |    –    |
| `shape.placeholder`    |  –  |  –  |  –   |  –   |  RW  |  –  |  –  |    –    |   –   |    –    |
| `doc.resources`        |  –  |  –  |  –   |  –   |  –   |  –  |  –  |    –    |   –   |    –    |
| `review.comments`      |  –  |  –  |  RW  |  –   |  –   |  –  |  –  |    –    |   –   |    –    |
| `review.threads`       |  –  |  –  |  RW  |  –   |  –   |  –  |  –  |    –    |   –   |    –    |
| `attr.id`              |  –  |  –  |  –   | R*W* |  –   |  –  |  –  |    –    |   –   |    –    |
| `attr.classes`         |  –  |  –  |  –   |  –   |  –   |  –  |  –  |    –    |   –   |    –    |
| `attr.keyValue`        |  –  |  –  |  R   |  –   |  –   |  –  |  –  |    –    |   –   |    –    |
| `attr.style`           |  –  |  –  |  –   |  –   |  –   |  –  |  –  |    –    |   –   |    –    |

<!-- feature-matrix:end -->
