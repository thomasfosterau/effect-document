/**
 * Profile honesty (#109): every feature in a format's write profile must
 * survive `read(write(doc))`. For each such feature a small sample document
 * exercising it is written and read back; the feature must still be used
 * (or, for the few purely textual normalisations, the text must match).
 */

import * as Predicate from "effect/Predicate";
import { describe, expect, test } from "vite-plus/test";
import * as Effect from "effect/Effect";
import { convert, narrow } from "@thomasfosterau/effect-document";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import {
  type AnyFormat,
  type Block,
  BlockQuote,
  CellRichText,
  CellText,
  Code,
  CodeBlock,
  collectFeatures,
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
  SoftBreak,
  Space,
  Span,
  Str,
  Cite,
  Citation,
  blocksToText,
  bulletList,
  bytes,
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
  trustAs,
  Underline,
  worksheet,
  Worksheet,
} from "@thomasfosterau/effect-document";
import * as Csv from "@thomasfosterau/effect-csv";
import { Docx, Pptx, Xlsx } from "@thomasfosterau/effect-ooxml";
import * as Pdf from "@thomasfosterau/effect-pdf";
import * as Rtf from "@thomasfosterau/effect-rtf";

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
const SHEET: Partial<Record<Feature, Block[]>> = {
  "sheet.worksheet": [worksheet("S", [[cell.text("x")]])],
  "sheet.multiple": [worksheet("A", [[cell.text("x")]]), worksheet("B", [[cell.text("y")]])],
  "sheet.merges": [
    new Worksheet({
      name: "S",
      columns: [],
      rows: worksheet("S", [[cell.text("x"), cell.blank()]]).rows,
      merges: [new MergeRange({ fromRow: 0, fromCol: 0, toRow: 0, toCol: 1 })],
    }),
  ],
  "sheet.columns": [
    new Worksheet({
      name: "S",
      columns: [new SheetColumn({ width: 20 })],
      rows: worksheet("S", [[cell.text("x")]]).rows,
      merges: [],
    }),
  ],
  "cell.text": [worksheet("S", [[cell.text("x")]])],
  "cell.number": [worksheet("S", [[cell.number(1.5)]])],
  "cell.boolean": [worksheet("S", [[cell.boolean(true)]])],
  "cell.date": [worksheet("S", [[cell.date(new Date("2024-01-02T00:00:00Z"))]])],
  "cell.error": [worksheet("S", [[cell.error("#DIV/0!")]])],
  "cell.blank": [worksheet("S", [[cell.text("x"), cell.blank(), cell.text("y")]])],
  "cell.formula": [worksheet("S", [[cell.formula("1+1", "2")]])],
  "cell.richText": [worksheet("S", [[new CellRichText({ runs: [strong([s("x")])] })]])],
  "cell.style": [worksheet("S", [[new CellText({ value: "x", style: { font: { bold: true } } })]])],
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

/** Features whose loss is a purely textual normalisation (same text, simpler nodes). */
const TEXTUAL: ReadonlySet<Feature> = new Set(["inline.space", "inline.softBreak", "block.plain"]);

/** Text with whitespace runs collapsed, for comparing textual normalisations. */
const squash = (text: string) => text.replace(/\s+/g, " ").trim();

/** The sample document for `feature` in a format of the given family. */
const sampleFor = (feature: Feature, family: "prose" | "sheet" | "deck"): Document | undefined => {
  const inline = INLINE[feature];
  const block = BLOCK[feature];
  // Body text around the sample gives layout-inferring readers (PDF) context.
  const around = (blocks: Block[]) => [
    para([s("Intro text.")]),
    ...blocks,
    para([s("Outro text.")]),
  ];
  const wrap = (blocks: Block[]) =>
    family === "deck"
      ? document([slideShow([slide([textBox(around(blocks))])])])
      : document(around(blocks));
  if (feature.startsWith("inline.") && inline !== undefined && family !== "sheet") {
    return wrap([para([s("a "), inline, s(" b")])]);
  }
  if (feature.startsWith("block.") && block !== undefined && family !== "sheet")
    return wrap([block]);
  if (family === "sheet" && SHEET[feature] !== undefined) return document(SHEET[feature]!);
  if (family === "deck" && DECK[feature] !== undefined) return document(DECK[feature]!);
  return undefined;
};

export const FORMATS: ReadonlyArray<readonly [AnyFormat, "prose" | "sheet" | "deck"]> = [
  [Csv.format as unknown as AnyFormat, "sheet"],
  [Xlsx.format as unknown as AnyFormat, "sheet"],
  [Docx.format as unknown as AnyFormat, "prose"],
  [Pptx.format as unknown as AnyFormat, "deck"],
  [Rtf.format as unknown as AnyFormat, "prose"],
  [Pdf.format as unknown as AnyFormat, "prose"],
];

describe("write profiles round-trip (#109)", () => {
  for (const [format, family] of FORMATS) {
    const profile = format.writeProfile;
    test(`${format.id}: every write-profile feature survives write -> read`, () => {
      const lost: string[] = [];
      for (const feature of profile.features) {
        if (feature.startsWith("attr.")) continue;
        const doc = sampleFor(feature, family);
        if (doc === undefined) continue;
        const back = Effect.runSync(
          Effect.flatMap(format.writer!.write(trustAs(doc)), (c) => format.reader!.read(c)),
        );
        const kept =
          collectFeatures(back).has(feature) ||
          (TEXTUAL.has(feature) &&
            squash(blocksToText(back.blocks)) === squash(blocksToText(doc.blocks)));
        if (!kept) lost.push(feature);
        expect(format.readProfile.is(back)).toBe(true);
      }
      expect(lost).toEqual([]);
    });
  }
});

describe("convert reports what a writer can't preserve (#109)", () => {
  test("XLSX -> XLSX reports a date cell, which the writer stores as text", () => {
    // A workbook whose A1 is an ISO date cell (t="d"), which the reader reads as CellDate.
    const out = Effect.runSync(
      Xlsx.makeXlsxWriter().write(trustAs(document([worksheet("S", [[cell.number(1)]])]))),
    );
    if (!Predicate.isTagged(out, "Bytes")) throw new Error("expected bytes");
    const files = unzipSync(out.bytes);
    files["xl/worksheets/sheet1.xml"] = strToU8(
      strFromU8(files["xl/worksheets/sheet1.xml"]!).replace(
        /<c r="A1"[^>]*>.*?<\/c>/,
        `<c r="A1" t="d"><v>2024-01-02T00:00:00Z</v></c>`,
      ),
    );
    const input = bytes(zipSync(files));
    const { loss } = Effect.runSync(convert({ from: Xlsx.format, to: Xlsx.format, input }));
    expect(loss.isLossless).toBe(false);
    expect(loss.entries.map((e) => e.feature)).toContain("cell.date");
  });

  test("narrowing to DOCX reports the rule the writer can't round-trip", () => {
    const { loss } = narrow(document([new HorizontalRule()]), Docx.format.writeProfile);
    expect(loss.entries.map((e) => e.feature)).toContain("block.horizontalRule");
  });
});
