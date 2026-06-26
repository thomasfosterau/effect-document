/**
 * The `Document` top level - metadata plus a sequence of blocks - together with
 * ergonomic constructors and text-collapse utilities.
 */

import { Schema } from "effect";
import {
  Block, BulletList, CellBlank, CellBoolean, CellDate, CellError, CellFormula,
  CellNumber, CellRichText, CellText, CodeBlock, ColSpec, Emph, Header, type Inline, Link,
  OrderedList, Para, Plain, type SheetCell, SheetRow, Slide, SlideShow,
  type Shape, Str, Strong, Table, TableCell, TableRow, TextBox, Worksheet,
} from "./ast.js";

// ============================================================================
// Document
// ============================================================================

/** Document metadata (title, author, arbitrary key/values). */
export const Meta = Schema.Record({ key: Schema.String, value: Schema.Unknown });
export type Meta = Schema.Schema.Type<typeof Meta>;

/** A complete document: metadata plus a sequence of blocks. */
export class Document extends Schema.Class<Document>("Document")({
  meta: Meta,
  blocks: Schema.Array(Block),
}) {}

/** The plain-JSON encoded form of a `Document`. */
export type DocumentEncoded = Schema.Schema.Encoded<typeof Document>;

// ============================================================================
// Constructors - inline
// ============================================================================

export const str = (text: string): Str => new Str({ text });
export const emph = (content: ReadonlyArray<Inline>): Emph => new Emph({ content });
export const strong = (content: ReadonlyArray<Inline>): Strong => new Strong({ content });
export const link = (
  content: ReadonlyArray<Inline>,
  url: string,
  title?: string
): Link => new Link({ content, target: { url, title } });

// ============================================================================
// Constructors - block
// ============================================================================

export const para = (content: ReadonlyArray<Inline>): Para => new Para({ content });
export const plain = (content: ReadonlyArray<Inline>): Plain => new Plain({ content });
export const plainText = (text: string): Plain => new Plain({ content: [new Str({ text })] });
export const header = (level: number, content: ReadonlyArray<Inline>): Header =>
  new Header({ level, content });
export const codeBlock = (text: string, language?: string): CodeBlock =>
  new CodeBlock({ text, language });
export const bulletList = (items: ReadonlyArray<ReadonlyArray<Block>>): BulletList =>
  new BulletList({ items });
export const orderedList = (items: ReadonlyArray<ReadonlyArray<Block>>): OrderedList =>
  new OrderedList({ items });

/** A prose table from header strings and a grid of block-cell content. */
export const table = (options: {
  readonly caption?: ReadonlyArray<Inline>;
  readonly headers?: ReadonlyArray<string>;
  readonly rows: ReadonlyArray<ReadonlyArray<ReadonlyArray<Block>>>;
}): Table => {
  const colCount = Math.max(
    options.headers?.length ?? 0,
    ...options.rows.map((r) => r.length)
  );
  const head =
    options.headers === undefined
      ? []
      : [
          new TableRow({
            cells: options.headers.map(
              (h) => new TableCell({ content: [plainText(h)] })
            ),
          }),
        ];
  const body = options.rows.map(
    (row) => new TableRow({ cells: row.map((blocks) => new TableCell({ content: blocks })) })
  );
  return new Table({
    caption: options.caption,
    colSpecs: Array.from({ length: colCount }, () => new ColSpec({})),
    head,
    body,
    foot: [],
  });
};

// ============================================================================
// Constructors - spreadsheet
// ============================================================================

/** Ergonomic spreadsheet-cell constructors. */
export const cell = {
  text: (value: string): CellText => new CellText({ value }),
  number: (value: number): CellNumber => new CellNumber({ value }),
  boolean: (value: boolean): CellBoolean => new CellBoolean({ value }),
  date: (value: Date): CellDate => new CellDate({ value }),
  error: (value: string): CellError => new CellError({ value }),
  blank: (): CellBlank => new CellBlank(),
  formula: (formula: string, result?: string): CellFormula =>
    new CellFormula({ formula, result }),
  richText: (runs: ReadonlyArray<Inline>): CellRichText => new CellRichText({ runs }),
} as const;

/** A worksheet from optional header strings and a grid of cells. */
export const worksheet = (
  name: string,
  rows: ReadonlyArray<ReadonlyArray<SheetCell>>,
  headers?: ReadonlyArray<string>
): Worksheet => {
  const allRows =
    headers === undefined
      ? rows
      : [headers.map((h) => cell.text(h)), ...rows];
  return new Worksheet({
    name,
    columns: [],
    rows: allRows.map((cells) => new SheetRow({ cells })),
    merges: [],
  });
};

// ============================================================================
// Constructors - presentation
// ============================================================================

export const textBox = (content: ReadonlyArray<Block>): TextBox => new TextBox({ content });
export const slide = (
  shapes: ReadonlyArray<Shape>,
  notes?: ReadonlyArray<Block>
): Slide => new Slide({ shapes, notes });
export const slideShow = (slides: ReadonlyArray<Slide>): SlideShow =>
  new SlideShow({ slides });

// ============================================================================
// Document constructor
// ============================================================================

/** Construct a document from blocks (with optional metadata). */
export const document = (
  blocks: ReadonlyArray<Block>,
  meta: Meta = {}
): Document => new Document({ meta, blocks });

// ============================================================================
// Text-collapse utilities
// ============================================================================

/** Collapse a sequence of inlines to plain text. */
export const inlinesToText = (inlines: ReadonlyArray<Inline>): string =>
  inlines
    .map((inline): string => {
      switch (inline._tag) {
        case "Str":
          return inline.text;
        case "Code":
        case "Math":
        case "RawInline":
          return inline.text;
        case "Space":
        case "SoftBreak":
          return " ";
        case "LineBreak":
          return "\n";
        case "Image":
          return inlinesToText(inline.alt);
        case "Emph":
        case "Strong":
        case "Underline":
        case "Strikeout":
        case "Superscript":
        case "Subscript":
        case "SmallCaps":
        case "Quoted":
        case "Cite":
        case "Link":
        case "Span":
          return inlinesToText(inline.content);
        case "Note":
          return "";
      }
    })
    .join("");

/** Collapse a single spreadsheet cell to plain text. */
export const cellToText = (c: SheetCell): string => {
  switch (c._tag) {
    case "CellText":
    case "CellError":
      return c.value;
    case "CellNumber":
      return String(c.value);
    case "CellBoolean":
      return c.value ? "true" : "false";
    case "CellDate":
      return c.value.toISOString();
    case "CellBlank":
      return "";
    case "CellFormula":
      return c.result ?? "";
    case "CellRichText":
      return inlinesToText(c.runs);
  }
};

/** Collapse a single slide shape to plain text. */
export const shapeToText = (shape: Shape): string => {
  switch (shape._tag) {
    case "Picture":
      return shape.alt ?? "";
    case "TableShape":
      return blocksToText([shape.table]);
    case "TextBox":
    case "Placeholder":
      return blocksToText(shape.content);
  }
};

/** Collapse a sequence of blocks to plain text (one line per block). */
export const blocksToText = (blocks: ReadonlyArray<Block>): string =>
  blocks
    .map((block): string => {
      switch (block._tag) {
        case "Plain":
        case "Para":
        case "Header":
          return inlinesToText(block.content);
        case "LineBlock":
          return block.lines.map(inlinesToText).join("\n");
        case "CodeBlock":
        case "RawBlock":
          return block.text;
        case "BlockQuote":
        case "Div":
        case "Figure":
          return blocksToText(block.content);
        case "OrderedList":
        case "BulletList":
          return block.items.map(blocksToText).join("\n");
        case "DefinitionList":
          return block.items
            .map((it) => inlinesToText(it.term) + "\n" + it.definitions.map(blocksToText).join("\n"))
            .join("\n");
        case "HorizontalRule":
          return "";
        case "Table":
          return [...block.head, ...block.body, ...block.foot]
            .map((row) => row.cells.map((cl) => blocksToText(cl.content)).join("\t"))
            .join("\n");
        case "Worksheet":
          return block.rows
            .map((row) => row.cells.map(cellToText).join("\t"))
            .join("\n");
        case "SlideShow":
          return block.slides
            .map((s) => s.shapes.map(shapeToText).join("\n"))
            .join("\n\n");
      }
    })
    .join("\n");
