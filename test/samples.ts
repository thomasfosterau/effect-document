/**
 * A small sample document for each feature, shared by the suites that write
 * every feature a format supports: the write-profile round trip
 * (`integration/profile-roundtrip.test.ts`, #109) and the output validators
 * (`validate/`, #134).
 */

import {
  type Block,
  BlockQuote,
  CellRichText,
  CellText,
  Code,
  CodeBlock,
  DefinitionList,
  Div,
  document,
  type Document,
  type Feature,
  Figure,
  HorizontalRule,
  Image,
  type Inline,
  LineBlock,
  LineBreak,
  Link,
  Math,
  MergeRange,
  Note,
  Placeholder,
  Plain,
  Quoted,
  RawBlock,
  RawInline,
  SheetColumn,
  type SheetCell,
  SoftBreak,
  Space,
  Span,
  Str,
  Cite,
  Citation,
  bulletList,
  cell,
  emph,
  header,
  orderedList,
  para,
  Picture,
  slide,
  slideShow,
  SmallCaps,
  Strikeout,
  strong,
  Subscript,
  Superscript,
  table,
  TableShape,
  textBox,
  Underline,
  worksheet,
  Worksheet,
} from "@thomasfosterau/effect-document";

const s = (text: string) => new Str({ text });

/** An inline sample for each inline feature. */
const INLINE: Partial<Record<Feature, Inline>> = {
  "inline.str": s("x"),
  "inline.space": new Space(),
  "inline.softBreak": new SoftBreak(),
  "inline.lineBreak": new LineBreak(),
  "inline.emph": emph([s("x")]),
  "inline.strong": strong([s("x")]),
  "inline.underline": new Underline({ content: [s("x")] }),
  "inline.strikeout": new Strikeout({ content: [s("x")] }),
  "inline.superscript": new Superscript({ content: [s("x")] }),
  "inline.subscript": new Subscript({ content: [s("x")] }),
  "inline.smallCaps": new SmallCaps({ content: [s("x")] }),
  "inline.quoted": new Quoted({ quoteType: "double", content: [s("x")] }),
  "inline.cite": new Cite({
    citations: [new Citation({ id: "c", prefix: [], suffix: [], mode: "normal" })],
    content: [s("x")],
  }),
  "inline.code": new Code({ text: "x" }),
  "inline.math": new Math({ mathType: "inline", text: "x" }),
  "inline.rawInline": new RawInline({ format: "html", text: "x" }),
  "inline.link": new Link({ content: [s("x")], target: { url: "https://example.com/" } }),
  "inline.image": new Image({ alt: [s("x")], target: { url: "x.png" } }),
  "inline.note": new Note({ content: [para([s("x")])] }),
  "inline.span": new Span({ content: [s("x")] }),
};

/** A block sample for each block feature. */
const BLOCK: Partial<Record<Feature, Block>> = {
  "block.plain": new Plain({ content: [s("x")] }),
  "block.para": para([s("x")]),
  "block.lineBlock": new LineBlock({ lines: [[s("a")], [s("b")]] }),
  "block.codeBlock": new CodeBlock({ text: "x = 1" }),
  "block.rawBlock": new RawBlock({ format: "html", text: "<p>x</p>" }),
  "block.blockQuote": new BlockQuote({ content: [para([s("x")])] }),
  "block.orderedList": orderedList([[para([s("a")])], [para([s("b")])]]),
  "block.bulletList": bulletList([[para([s("a")])], [para([s("b")])]]),
  "block.definitionList": new DefinitionList({
    items: [{ term: [s("t")], definitions: [[para([s("d")])]] }],
  }),
  "block.header": header(1, [s("x")]),
  "block.horizontalRule": new HorizontalRule(),
  "block.figure": new Figure({ caption: [para([s("c")])], content: [para([s("x")])] }),
  "block.div": new Div({ content: [para([s("x")])] }),
  "block.table": table({ rows: [[[para([s("a")])], [para([s("b")])]]] }),
};

/** A sheet-level sample for each spreadsheet feature. */
/**
 * A worksheet with a header row above `rows`, as real spreadsheets and CSV
 * files have: the CSV reader sniffs a text first row over typed columns as the
 * header (#88), so a sample's typed cells sit in the data rows.
 */
const sheet = (name: string, rows: ReadonlyArray<ReadonlyArray<SheetCell>>) =>
  worksheet(name, [(rows[0] ?? []).map((_, c) => cell.text(`h${c + 1}`)), ...rows]);

const SHEET: Partial<Record<Feature, Block[]>> = {
  "sheet.worksheet": [sheet("S", [[cell.text("x")]])],
  "sheet.multiple": [sheet("A", [[cell.text("x")]]), sheet("B", [[cell.text("y")]])],
  "sheet.merges": [
    new Worksheet({
      name: "S",
      columns: [],
      rows: sheet("S", [[cell.text("x"), cell.blank()]]).rows,
      merges: [new MergeRange({ fromRow: 1, fromCol: 0, toRow: 1, toCol: 1 })],
    }),
  ],
  "sheet.columns": [
    new Worksheet({
      name: "S",
      columns: [new SheetColumn({ width: 20 })],
      rows: sheet("S", [[cell.text("x")]]).rows,
      merges: [],
    }),
  ],
  "cell.text": [sheet("S", [[cell.text("x")]])],
  "cell.number": [sheet("S", [[cell.number(1.5)]])],
  "cell.boolean": [sheet("S", [[cell.boolean(true)]])],
  "cell.date": [sheet("S", [[cell.date(new Date("2024-01-02T00:00:00Z"))]])],
  "cell.error": [sheet("S", [[cell.error("#DIV/0!")]])],
  "cell.blank": [sheet("S", [[cell.text("x"), cell.blank(), cell.text("y")]])],
  "cell.formula": [sheet("S", [[cell.formula("1+1", "2")]])],
  "cell.richText": [sheet("S", [[new CellRichText({ runs: [strong([s("x")])] })]])],
  "cell.style": [sheet("S", [[new CellText({ value: "x", style: { font: { bold: true } } })]])],
};

/** A deck-level sample for each presentation feature. */
const DECK: Partial<Record<Feature, Block[]>> = {
  "deck.slideShow": [slideShow([slide([textBox([para([s("x")])])])])],
  "deck.notes": [slideShow([slide([textBox([para([s("x")])])], [para([s("n")])])])],
  "shape.textBox": [slideShow([slide([textBox([para([s("x")])])])])],
  "shape.picture": [slideShow([slide([new Picture({ src: "x.png", alt: "x" })])])],
  "shape.table": [
    slideShow([slide([new TableShape({ table: table({ rows: [[[para([s("x")])]]] }) })])]),
  ],
  "shape.placeholder": [
    slideShow([slide([new Placeholder({ placeholderType: "body", content: [para([s("x")])] })])]),
  ],
};

/** The kind of document a format holds, which decides how a feature's sample is wrapped. */
export type Family = "prose" | "sheet" | "deck";

/** The prose blocks sampling an inline or block feature, if it is one. */
const proseSample = (feature: Feature): Block[] | undefined => {
  const inline = INLINE[feature];
  if (inline !== undefined) return [para([s("a "), inline, s(" b")])];
  const block = BLOCK[feature];
  return block === undefined ? undefined : [block];
};

/**
 * Prose blocks as a document of the family, between body paragraphs that
 * give layout-inferring readers (PDF) context; a deck holds them in a text box.
 */
const wrapProse = (blocks: Block[], family: Family): Document => {
  const around = [para([s("Intro text.")]), ...blocks, para([s("Outro text.")])];
  return family === "deck" ? document([slideShow([slide([textBox(around)])])]) : document(around);
};

/**
 * The sample document for `feature` in a format of the given family, or
 * `undefined` when the feature has no sample there (an attribute facet, or a
 * prose feature in a spreadsheet format).
 */
export const sampleFor = (feature: Feature, family: Family): Document | undefined => {
  const own = family === "sheet" ? SHEET[feature] : family === "deck" ? DECK[feature] : undefined;
  if (own !== undefined) return document(own);
  if (family === "sheet") return undefined;
  const prose = proseSample(feature);
  return prose === undefined ? undefined : wrapProse(prose, family);
};
