/**
 * The `Document` top level - metadata plus a sequence of blocks - together with
 * ergonomic constructors and text-collapse utilities.
 */

import * as Match from "effect/Match";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import {
  type RowCell,
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
  SheetRow,
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
import { rowEntries, sheetRow } from "./sheet.ts";
import {
  trustedBlank,
  trustedBoolean,
  trustedNumber,
  trustedStr,
  trustedText,
  trustedWorksheet,
} from "./trusted.ts";

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
export const str = (text: string): Str =>
  // a string is all the schema pass would check, so skip it (readers build a
  // run per span of text)
  Predicate.isString(text) ? trustedStr(text) : new Str({ text });
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
export const plainText = (text: string): Plain => new Plain({ content: [str(text)] });
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

/**
 * Ergonomic spreadsheet-cell constructors. `text`, `number`, `boolean` and
 * `blank` skip the schema pass for a value of the right primitive type (the
 * readers build cells by the million, and the pass is most of their time);
 * any other value goes through the class constructor and fails as it does.
 */
export const cell = {
  text: (value: string): CellText =>
    Predicate.isString(value) ? trustedText(value) : new CellText({ value }),
  number: (value: number): CellNumber =>
    Predicate.isNumber(value) ? trustedNumber(value) : new CellNumber({ value }),
  boolean: (value: boolean): CellBoolean =>
    Predicate.isBoolean(value) ? trustedBoolean(value) : new CellBoolean({ value }),
  date: (value: Date): CellDate => new CellDate({ value }),
  error: (value: string): CellError => new CellError({ value }),
  blank: (): CellBlank => trustedBlank(),
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
  rows: ReadonlyArray<ReadonlyArray<RowCell>>,
  headers?: ReadonlyArray<string>,
): Worksheet => {
  const allRows = headers === undefined ? rows : [headers.map((h) => cell.text(h)), ...rows];
  const sheetRows = allRows.map((cells, index) => sheetRow(index, cells));
  // `sheetRow` returns a SheetRow at each index 0, 1, 2, …, so the rows are
  // already what the schema pass would accept; only the name is left to check
  return Predicate.isString(name)
    ? trustedWorksheet(name, sheetRows)
    : new Worksheet({ name, columns: [], rows: sheetRows, merges: [] });
};

/**
 * A worksheet of finished rows, for readers that build each row as they go
 * (`sheetRow`, `sparseRow`). Rows that are `SheetRow` instances in strictly
 * ascending index order skip the schema pass; anything else is checked and
 * fails as `new Worksheet` does.
 *
 * @example
 * ```ts
 * import { cell, sheetRow, worksheetFromRows } from "@thomasfosterau/effect-document"
 *
 * worksheetFromRows("Sheet1", [sheetRow(0, [cell.text("a")]), sheetRow(2, [cell.number(1)])])
 * ```
 */
export const worksheetFromRows = (name: string, rows: ReadonlyArray<SheetRow>): Worksheet =>
  Predicate.isString(name) &&
  rows.every(
    (row, i) => row instanceof SheetRow && (i === 0 || row.index > (rows[i - 1]?.index ?? -1)),
  )
    ? trustedWorksheet(name, rows)
    : new Worksheet({ name, columns: [], rows, merges: [] });

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

/** A node's own `text`, as its only part. */
const textPart = (n: { readonly text: string }): TextPart[] => [n.text];
/** A node's inline `content`, as parts. */
const contentParts = (n: { readonly content: ReadonlyArray<Inline> }): TextPart[] =>
  inlineParts(n.content);
/** A space, as its only part. */
const spacePart = (): TextPart[] => [" "];
/** A cell's own `value`, as its only part. */
const valuePart = (n: { readonly value: string }): TextPart[] => [n.value];
/** A shape's blocks, one per line. */
const proseParts = (n: { readonly content: ReadonlyArray<Block> }): TextPart[] =>
  joinParts(
    n.content.map((b) => [{ b }]),
    "\n",
  );
/** Blocks, one per line. */
const blockParts = (bs: ReadonlyArray<Block>): TextPart[] =>
  joinParts(
    bs.map((b) => [{ b }]),
    "\n",
  );
/** A container's blocks, one per line. */
const nestedParts = (n: { readonly content: ReadonlyArray<Block> }): TextPart[] =>
  blockParts(n.content);
/** A list's items, one per line. */
const itemParts = (n: { readonly items: ReadonlyArray<ReadonlyArray<Block>> }): TextPart[] =>
  joinParts(n.items.map(blockParts), "\n");

const expandInline = (inline: Inline): TextPart[] => {
  return Match.valueTags(inline, {
    Str: textPart,
    Code: textPart,
    Math: textPart,
    RawInline: textPart,
    Space: spacePart,
    SoftBreak: spacePart,
    LineBreak: () => ["\n"],
    Image: (n) => inlineParts(n.alt),
    Emph: contentParts,
    Strong: contentParts,
    Underline: contentParts,
    Strikeout: contentParts,
    Superscript: contentParts,
    Subscript: contentParts,
    SmallCaps: contentParts,
    Quoted: contentParts,
    Cite: contentParts,
    Link: contentParts,
    Span: contentParts,
    Note: () => [],
  });
};

const expandCell = (c: SheetCell): TextPart[] => {
  return Match.valueTags(c, {
    CellText: valuePart,
    CellError: valuePart,
    CellNumber: (n) => [String(n.value)],
    CellBoolean: (n) => [n.value ? "true" : "false"],
    CellDate: (n) => [n.value.toISOString()],
    CellBlank: () => [""],
    CellFormula: (n) => [n.result ?? ""],
    CellRichText: (n) => inlineParts(n.runs),
  });
};

const expandShape = (shape: Shape): TextPart[] => {
  return Match.valueTags(shape, {
    Picture: (n) => [n.alt ?? ""],
    TableShape: (n) => [{ b: n.table }],
    TextBox: proseParts,
    Placeholder: proseParts,
  });
};

const expandBlock = (block: Block): TextPart[] => {
  return Match.valueTags(block, {
    Plain: contentParts,
    Para: contentParts,
    Header: contentParts,
    LineBlock: (n) => joinParts(n.lines.map(inlineParts), "\n"),
    CodeBlock: textPart,
    RawBlock: textPart,
    BlockQuote: nestedParts,
    Div: nestedParts,
    Figure: nestedParts,
    OrderedList: itemParts,
    BulletList: itemParts,
    DefinitionList: (n) =>
      joinParts(
        n.items.map((it) => [
          ...inlineParts(it.term),
          "\n",
          ...joinParts(it.definitions.map(blockParts), "\n"),
        ]),
        "\n",
      ),
    HorizontalRule: () => [""],
    Table: (n) =>
      joinParts(
        [...n.head, ...n.body, ...n.foot].map((row) =>
          joinParts(
            row.cells.map((cl) => blockParts(cl.content)),
            "\t",
          ),
        ),
        "\n",
      ),
    // A worksheet's text is its cells, tab-separated within a row and one line
    // per row it holds: gaps are not laid out, so the text stays proportional
    // to the cells however far apart they are (#185).
    Worksheet: (n) =>
      joinParts(
        n.rows.map((row) =>
          joinParts(
            rowEntries(row).map(([, c]) => [{ c }]),
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
  const stack: TextPart[] = parts.toReversed();
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
export const cellToText = (c: SheetCell): string => {
  // Every cell but rich text is a single value, read directly: writers call
  // this once per cell, and the collapse (a stack, a part per node, a
  // `Match` per node) costs several times the value itself. The texts are
  // the ones `expandCell` gives.
  if (Predicate.isTagged(c, "CellText") || Predicate.isTagged(c, "CellError")) return c.value;
  if (Predicate.isTagged(c, "CellNumber")) return String(c.value);
  if (Predicate.isTagged(c, "CellBoolean")) return c.value ? "true" : "false";
  if (Predicate.isTagged(c, "CellBlank")) return "";
  if (Predicate.isTagged(c, "CellFormula")) return c.result ?? "";
  if (Predicate.isTagged(c, "CellDate")) return c.value.toISOString();
  return collapse([{ c }]);
};

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
