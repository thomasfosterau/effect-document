/**
 * The `Document` top level - metadata plus a sequence of blocks - together with
 * ergonomic constructors and text-collapse utilities.
 */

import * as Match from "effect/Match";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import {
  Block,
  BulletList,
  CellBlank,
  CellBoolean,
  CellDate,
  CellError,
  CellFormula,
  CellNumber,
  CellRichText,
  CellText,
  CodeBlock,
  ColSpec,
  Emph,
  Header,
  type Inline,
  Link,
  OrderedList,
  Para,
  Plain,
  type SheetCell,
  Slide,
  SlideShow,
  type Shape,
  Str,
  Strong,
  Table,
  TableCell,
  TableRow,
  TextBox,
  Worksheet,
} from "./ast.ts";
import { denseRows, sheetRow } from "./sheet.ts";

// ============================================================================
// Document
// ============================================================================

/** Document metadata (title, author, arbitrary key/values). */
export const Meta = Schema.Record(Schema.String, Schema.Unknown);
export type Meta = Schema.Schema.Type<typeof Meta>;

/** A complete document: metadata plus a sequence of blocks. */
export class Document extends Schema.Class<Document>("Document")({
  meta: Meta,
  blocks: Schema.Array(Block),
}) {}

/** The plain-JSON encoded form of a `Document`. */
export type DocumentEncoded = Schema.Codec.Encoded<typeof Document>;

// ============================================================================
// Constructors - inline
// ============================================================================

/** A `Str`: a run of text. */
export const str = (text: string): Str => new Str({ text });
/** An `Emph` (emphasis, usually italic) around `content`. */
export const emph = (content: ReadonlyArray<Inline>): Emph => new Emph({ content });
/** A `Strong` (strong emphasis, usually bold) around `content`. */
export const strong = (content: ReadonlyArray<Inline>): Strong => new Strong({ content });
/** A `Link` to `url` (with an optional `title`) around `content`. */
export const link = (content: ReadonlyArray<Inline>, url: string, title?: string): Link =>
  new Link({ content, target: { url, title } });

// ============================================================================
// Constructors - block
// ============================================================================

/** A `Para`: a paragraph of inline content. */
export const para = (content: ReadonlyArray<Inline>): Para => new Para({ content });
/** A `Plain` block: inline content with no paragraph semantics (as in a tight list item). */
export const plain = (content: ReadonlyArray<Inline>): Plain => new Plain({ content });
/** A `Plain` block holding a single `Str` of `text`. */
export const plainText = (text: string): Plain => new Plain({ content: [new Str({ text })] });
/** A `Header` of `level` 1–6 around `content`. */
export const header = (level: number, content: ReadonlyArray<Inline>): Header =>
  new Header({ level, content });
/** A `CodeBlock` of verbatim `text`, optionally tagged with its `language`. */
export const codeBlock = (text: string, language?: string): CodeBlock =>
  new CodeBlock({ text, language });
/** A `BulletList`; each item is a sequence of blocks. */
export const bulletList = (items: ReadonlyArray<ReadonlyArray<Block>>): BulletList =>
  new BulletList({ items });
/** An `OrderedList` with default numbering; each item is a sequence of blocks. */
export const orderedList = (items: ReadonlyArray<ReadonlyArray<Block>>): OrderedList =>
  new OrderedList({ items });

/** A prose table from header strings and a grid of block-cell content. */
export const table = (options: {
  readonly caption?: ReadonlyArray<Inline> | undefined;
  readonly headers?: ReadonlyArray<string> | undefined;
  readonly rows: ReadonlyArray<ReadonlyArray<ReadonlyArray<Block>>>;
}): Table => {
  const colCount = Math.max(options.headers?.length ?? 0, ...options.rows.map((r) => r.length));
  const head =
    options.headers === undefined
      ? []
      : [
          new TableRow({
            cells: options.headers.map((h) => new TableCell({ content: [plainText(h)] })),
          }),
        ];
  const body = options.rows.map(
    (row) => new TableRow({ cells: row.map((blocks) => new TableCell({ content: blocks })) }),
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
  formula: (formula: string, result?: string): CellFormula => new CellFormula({ formula, result }),
  richText: (runs: ReadonlyArray<Inline>): CellRichText => new CellRichText({ runs }),
} as const;

/**
 * A worksheet from optional header strings and a dense grid of cells: row `r`
 * of the grid (after the header row, if any) becomes the row at index `r`,
 * and every cell given is kept, blanks included (see `sheetRow`).
 */
export const worksheet = (
  name: string,
  rows: ReadonlyArray<ReadonlyArray<SheetCell>>,
  headers?: ReadonlyArray<string>,
): Worksheet => {
  const allRows = headers === undefined ? rows : [headers.map((h) => cell.text(h)), ...rows];
  return new Worksheet({
    name,
    columns: [],
    rows: allRows.map((cells, index) => sheetRow(index, cells)),
    merges: [],
  });
};

// ============================================================================
// Constructors - presentation
// ============================================================================

/** A `TextBox` shape holding prose blocks. */
export const textBox = (content: ReadonlyArray<Block>): TextBox => new TextBox({ content });
/** A `Slide` of `shapes`, with optional speaker `notes`. */
export const slide = (shapes: ReadonlyArray<Shape>, notes?: ReadonlyArray<Block>): Slide =>
  new Slide({ shapes, notes });
/** A `SlideShow` block: the presentation as a sequence of slides. */
export const slideShow = (slides: ReadonlyArray<Slide>): SlideShow => new SlideShow({ slides });

// ============================================================================
// Document constructor
// ============================================================================

/** Construct a document from blocks (with optional metadata). */
export const document = (blocks: ReadonlyArray<Block>, meta: Meta = {}): Document =>
  new Document({ meta, blocks });

// ============================================================================
// Text-collapse utilities
// ============================================================================

// The collapse runs on an explicit stack so arbitrarily deep documents can't
// overflow the call stack: each node expands into the strings and child nodes
// of its text, in order, until only strings remain.

type TextPart =
  | string
  | { readonly b: Block }
  | { readonly i: Inline }
  | { readonly s: Shape }
  | { readonly c: SheetCell };

const inlineParts = (inlines: ReadonlyArray<Inline>): TextPart[] => inlines.map((i) => ({ i }));

/** `groups` joined by `sep`, like `groups.map(toText).join(sep)`. */
const joinParts = (groups: ReadonlyArray<ReadonlyArray<TextPart>>, sep: string): TextPart[] => {
  const out: TextPart[] = [];
  groups.forEach((g, n) => {
    if (n > 0) out.push(sep);
    out.push(...g);
  });
  return out;
};

const expandInline = (inline: Inline): TextPart[] => {
  const text = (n: { readonly text: string }): TextPart[] => [n.text];
  const content = (n: { readonly content: ReadonlyArray<Inline> }): TextPart[] =>
    inlineParts(n.content);
  const space = (): TextPart[] => [" "];
  return Match.valueTags(inline, {
    Str: text,
    Code: text,
    Math: text,
    RawInline: text,
    Space: space,
    SoftBreak: space,
    LineBreak: () => ["\n"],
    Image: (n) => inlineParts(n.alt),
    Emph: content,
    Strong: content,
    Underline: content,
    Strikeout: content,
    Superscript: content,
    Subscript: content,
    SmallCaps: content,
    Quoted: content,
    Cite: content,
    Link: content,
    Span: content,
    Note: () => [],
  });
};

const expandCell = (c: SheetCell): TextPart[] => {
  const value = (n: { readonly value: string }): TextPart[] => [n.value];
  return Match.valueTags(c, {
    CellText: value,
    CellError: value,
    CellNumber: (n) => [String(n.value)],
    CellBoolean: (n) => [n.value ? "true" : "false"],
    CellDate: (n) => [n.value.toISOString()],
    CellBlank: () => [""],
    CellFormula: (n) => [n.result ?? ""],
    CellRichText: (n) => inlineParts(n.runs),
  });
};

const expandShape = (shape: Shape): TextPart[] => {
  const prose = (n: { readonly content: ReadonlyArray<Block> }): TextPart[] =>
    joinParts(
      n.content.map((b) => [{ b }]),
      "\n",
    );
  return Match.valueTags(shape, {
    Picture: (n) => [n.alt ?? ""],
    TableShape: (n) => [{ b: n.table }],
    TextBox: prose,
    Placeholder: prose,
  });
};

const expandBlock = (block: Block): TextPart[] => {
  const blocks = (bs: ReadonlyArray<Block>) =>
    joinParts(
      bs.map((b) => [{ b }]),
      "\n",
    );
  const inlines = (n: { readonly content: ReadonlyArray<Inline> }): TextPart[] =>
    inlineParts(n.content);
  const text = (n: { readonly text: string }): TextPart[] => [n.text];
  const nested = (n: { readonly content: ReadonlyArray<Block> }): TextPart[] => blocks(n.content);
  const items = (n: { readonly items: ReadonlyArray<ReadonlyArray<Block>> }): TextPart[] =>
    joinParts(n.items.map(blocks), "\n");
  return Match.valueTags(block, {
    Plain: inlines,
    Para: inlines,
    Header: inlines,
    LineBlock: (n) => joinParts(n.lines.map(inlineParts), "\n"),
    CodeBlock: text,
    RawBlock: text,
    BlockQuote: nested,
    Div: nested,
    Figure: nested,
    OrderedList: items,
    BulletList: items,
    DefinitionList: (n) =>
      joinParts(
        n.items.map((it) => [
          ...inlineParts(it.term),
          "\n",
          ...joinParts(it.definitions.map(blocks), "\n"),
        ]),
        "\n",
      ),
    HorizontalRule: () => [""],
    Table: (n) =>
      joinParts(
        [...n.head, ...n.body, ...n.foot].map((row) =>
          joinParts(
            row.cells.map((cl) => blocks(cl.content)),
            "\t",
          ),
        ),
        "\n",
      ),
    Worksheet: (n) =>
      joinParts(
        denseRows(n, { rectangular: false }).map((row) =>
          joinParts(
            row.map((c) => [{ c }]),
            "\t",
          ),
        ),
        "\n",
      ),
    SlideShow: (n) =>
      joinParts(
        n.slides.map((sl) =>
          joinParts(
            sl.shapes.map((s) => [{ s }]),
            "\n",
          ),
        ),
        "\n\n",
      ),
  });
};

const collapse = (parts: ReadonlyArray<TextPart>): string => {
  let out = "";
  const stack: TextPart[] = [...parts].reverse();
  for (let part = stack.pop(); part !== undefined; part = stack.pop()) {
    if (Predicate.isString(part)) {
      out += part;
      continue;
    }
    const next =
      "b" in part
        ? expandBlock(part.b)
        : "i" in part
          ? expandInline(part.i)
          : "s" in part
            ? expandShape(part.s)
            : expandCell(part.c);
    for (let n = next.length - 1; n >= 0; n--) stack.push(next[n]!);
  }
  return out;
};

/** Collapse a sequence of inlines to plain text. */
export const inlinesToText = (inlines: ReadonlyArray<Inline>): string =>
  collapse(inlineParts(inlines));

/** Collapse a single spreadsheet cell to plain text. */
export const cellToText = (c: SheetCell): string => collapse([{ c }]);

/** Collapse a single slide shape to plain text. */
export const shapeToText = (shape: Shape): string => collapse([{ s: shape }]);

/** Collapse a sequence of blocks to plain text (one line per block). */
export const blocksToText = (blocks: ReadonlyArray<Block>): string =>
  collapse(
    joinParts(
      blocks.map((b) => [{ b }]),
      "\n",
    ),
  );
