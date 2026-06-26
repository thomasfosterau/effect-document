/**
 * The universal document AST - a Pandoc-superset that also models spreadsheets
 * (the `Worksheet` block + typed cells) and presentations (the `SlideShow`
 * block + slides/shapes). Every node is an Effect `Schema` class, so the whole
 * tree encodes to / decodes from plain JSON.
 *
 * The inline and block layers are mutually recursive (e.g. `Note` holds blocks,
 * table cells hold blocks, blocks hold inlines), so they live together here and
 * use suspended array helpers to tie the knot. The `*Encoded` interfaces give
 * TypeScript the plain-JSON shape it needs to type those suspended references.
 */

import { Schema } from "effect";
import { Attributes, Style, attrField } from "./attributes.js";

// ============================================================================
// Encoded (plain JSON) forms
// ============================================================================

type Attrs = Attributes; // attr encodes 1:1 (no Date/class-valued fields)
type CellAlign = "left" | "right" | "center" | "default";
type NumberStyle =
  | "default" | "example" | "decimal" | "lower-roman" | "upper-roman"
  | "lower-alpha" | "upper-alpha";
type NumberDelim = "default" | "period" | "one-paren" | "two-parens";

interface WrapInlineEncoded<T extends string> {
  readonly _tag: T;
  readonly content: ReadonlyArray<InlineEncoded>;
}

export interface StrEncoded {
  readonly _tag: "Str";
  readonly text: string;
}
export interface NoFieldEncoded<T extends string> {
  readonly _tag: T;
}
export interface QuotedEncoded {
  readonly _tag: "Quoted";
  readonly quoteType: "single" | "double";
  readonly content: ReadonlyArray<InlineEncoded>;
}
export interface CitationEncoded {
  readonly id: string;
  readonly mode: "author-in-text" | "suppress-author" | "normal";
  readonly prefix: ReadonlyArray<InlineEncoded>;
  readonly suffix: ReadonlyArray<InlineEncoded>;
}
export interface CiteEncoded {
  readonly _tag: "Cite";
  readonly citations: ReadonlyArray<CitationEncoded>;
  readonly content: ReadonlyArray<InlineEncoded>;
}
export interface CodeEncoded {
  readonly _tag: "Code";
  readonly attr?: Attrs;
  readonly text: string;
}
export interface MathEncoded {
  readonly _tag: "Math";
  readonly mathType: "inline" | "display";
  readonly text: string;
}
export interface RawInlineEncoded {
  readonly _tag: "RawInline";
  readonly format: string;
  readonly text: string;
}
export interface TargetEncoded {
  readonly url: string;
  readonly title?: string;
}
export interface LinkEncoded {
  readonly _tag: "Link";
  readonly attr?: Attrs;
  readonly content: ReadonlyArray<InlineEncoded>;
  readonly target: TargetEncoded;
}
export interface ImageEncoded {
  readonly _tag: "Image";
  readonly attr?: Attrs;
  readonly alt: ReadonlyArray<InlineEncoded>;
  readonly target: TargetEncoded;
}
export interface NoteEncoded {
  readonly _tag: "Note";
  readonly content: ReadonlyArray<BlockEncoded>;
}
export interface SpanEncoded {
  readonly _tag: "Span";
  readonly attr?: Attrs;
  readonly content: ReadonlyArray<InlineEncoded>;
}

export type InlineEncoded =
  | StrEncoded
  | NoFieldEncoded<"Space">
  | NoFieldEncoded<"SoftBreak">
  | NoFieldEncoded<"LineBreak">
  | WrapInlineEncoded<"Emph">
  | WrapInlineEncoded<"Strong">
  | WrapInlineEncoded<"Underline">
  | WrapInlineEncoded<"Strikeout">
  | WrapInlineEncoded<"Superscript">
  | WrapInlineEncoded<"Subscript">
  | WrapInlineEncoded<"SmallCaps">
  | QuotedEncoded
  | CiteEncoded
  | CodeEncoded
  | MathEncoded
  | RawInlineEncoded
  | LinkEncoded
  | ImageEncoded
  | NoteEncoded
  | SpanEncoded;

export interface PlainEncoded {
  readonly _tag: "Plain";
  readonly content: ReadonlyArray<InlineEncoded>;
}
export interface ParaEncoded {
  readonly _tag: "Para";
  readonly content: ReadonlyArray<InlineEncoded>;
}
export interface LineBlockEncoded {
  readonly _tag: "LineBlock";
  readonly lines: ReadonlyArray<ReadonlyArray<InlineEncoded>>;
}
export interface CodeBlockEncoded {
  readonly _tag: "CodeBlock";
  readonly attr?: Attrs;
  readonly text: string;
  readonly language?: string;
}
export interface RawBlockEncoded {
  readonly _tag: "RawBlock";
  readonly format: string;
  readonly text: string;
}
export interface BlockQuoteEncoded {
  readonly _tag: "BlockQuote";
  readonly content: ReadonlyArray<BlockEncoded>;
}
export interface OrderedListEncoded {
  readonly _tag: "OrderedList";
  readonly attr?: Attrs;
  readonly start?: number;
  readonly numberStyle?: NumberStyle;
  readonly numberDelim?: NumberDelim;
  readonly items: ReadonlyArray<ReadonlyArray<BlockEncoded>>;
}
export interface BulletListEncoded {
  readonly _tag: "BulletList";
  readonly attr?: Attrs;
  readonly items: ReadonlyArray<ReadonlyArray<BlockEncoded>>;
}
export interface DefinitionItemEncoded {
  readonly term: ReadonlyArray<InlineEncoded>;
  readonly definitions: ReadonlyArray<ReadonlyArray<BlockEncoded>>;
}
export interface DefinitionListEncoded {
  readonly _tag: "DefinitionList";
  readonly attr?: Attrs;
  readonly items: ReadonlyArray<DefinitionItemEncoded>;
}
export interface HeaderEncoded {
  readonly _tag: "Header";
  readonly level: number;
  readonly attr?: Attrs;
  readonly content: ReadonlyArray<InlineEncoded>;
}
export interface FigureEncoded {
  readonly _tag: "Figure";
  readonly attr?: Attrs;
  readonly caption: ReadonlyArray<BlockEncoded>;
  readonly content: ReadonlyArray<BlockEncoded>;
}
export interface DivEncoded {
  readonly _tag: "Div";
  readonly attr?: Attrs;
  readonly content: ReadonlyArray<BlockEncoded>;
}
export interface ColSpecEncoded {
  readonly align?: CellAlign;
  readonly width?: number | null;
}
export interface TableCellEncoded {
  readonly attr?: Attrs;
  readonly align?: CellAlign;
  readonly rowSpan?: number;
  readonly colSpan?: number;
  readonly content: ReadonlyArray<BlockEncoded>;
}
export interface TableRowEncoded {
  readonly cells: ReadonlyArray<TableCellEncoded>;
}
export interface TableEncoded {
  readonly _tag: "Table";
  readonly attr?: Attrs;
  readonly caption?: ReadonlyArray<InlineEncoded>;
  readonly colSpecs: ReadonlyArray<ColSpecEncoded>;
  readonly head: ReadonlyArray<TableRowEncoded>;
  readonly body: ReadonlyArray<TableRowEncoded>;
  readonly foot: ReadonlyArray<TableRowEncoded>;
}

// Spreadsheet encoded forms
type StyleE = Style;
export interface CellTextEncoded {
  readonly _tag: "CellText";
  readonly value: string;
  readonly style?: StyleE;
}
export interface CellNumberEncoded {
  readonly _tag: "CellNumber";
  readonly value: number;
  readonly style?: StyleE;
}
export interface CellBooleanEncoded {
  readonly _tag: "CellBoolean";
  readonly value: boolean;
  readonly style?: StyleE;
}
export interface CellDateEncoded {
  readonly _tag: "CellDate";
  readonly value: string; // ISO-8601 (Date encodes to string)
  readonly style?: StyleE;
}
export interface CellErrorEncoded {
  readonly _tag: "CellError";
  readonly value: string;
  readonly style?: StyleE;
}
export interface CellBlankEncoded {
  readonly _tag: "CellBlank";
  readonly style?: StyleE;
}
export interface CellFormulaEncoded {
  readonly _tag: "CellFormula";
  readonly formula: string;
  readonly result?: string;
  readonly style?: StyleE;
}
export interface CellRichTextEncoded {
  readonly _tag: "CellRichText";
  readonly runs: ReadonlyArray<InlineEncoded>;
  readonly style?: StyleE;
}
export type SheetCellEncoded =
  | CellTextEncoded
  | CellNumberEncoded
  | CellBooleanEncoded
  | CellDateEncoded
  | CellErrorEncoded
  | CellBlankEncoded
  | CellFormulaEncoded
  | CellRichTextEncoded;
export interface SheetColumnEncoded {
  readonly width?: number;
  readonly style?: StyleE;
}
export interface SheetRowEncoded {
  readonly cells: ReadonlyArray<SheetCellEncoded>;
  readonly height?: number;
}
export interface MergeRangeEncoded {
  readonly fromRow: number;
  readonly fromCol: number;
  readonly toRow: number;
  readonly toCol: number;
}
export interface WorksheetEncoded {
  readonly _tag: "Worksheet";
  readonly attr?: Attrs;
  readonly name: string;
  readonly columns: ReadonlyArray<SheetColumnEncoded>;
  readonly rows: ReadonlyArray<SheetRowEncoded>;
  readonly merges: ReadonlyArray<MergeRangeEncoded>;
}

// Presentation encoded forms
export interface TextBoxEncoded {
  readonly _tag: "TextBox";
  readonly attr?: Attrs;
  readonly content: ReadonlyArray<BlockEncoded>;
}
export interface PictureEncoded {
  readonly _tag: "Picture";
  readonly attr?: Attrs;
  readonly src: string;
  readonly alt?: string;
}
export interface TableShapeEncoded {
  readonly _tag: "TableShape";
  readonly attr?: Attrs;
  readonly table: TableEncoded;
}
export interface PlaceholderEncoded {
  readonly _tag: "Placeholder";
  readonly attr?: Attrs;
  readonly placeholderType: string;
  readonly idx?: number;
  readonly content: ReadonlyArray<BlockEncoded>;
}
export type ShapeEncoded =
  | TextBoxEncoded
  | PictureEncoded
  | TableShapeEncoded
  | PlaceholderEncoded;
export interface SlideEncoded {
  readonly attr?: Attrs;
  readonly layout?: string;
  readonly shapes: ReadonlyArray<ShapeEncoded>;
  readonly notes?: ReadonlyArray<BlockEncoded>;
}
export interface SlideSizeEncoded {
  readonly width: number;
  readonly height: number;
}
export interface SlideShowEncoded {
  readonly _tag: "SlideShow";
  readonly attr?: Attrs;
  readonly size?: SlideSizeEncoded;
  readonly slides: ReadonlyArray<SlideEncoded>;
}

export type BlockEncoded =
  | PlainEncoded
  | ParaEncoded
  | LineBlockEncoded
  | CodeBlockEncoded
  | RawBlockEncoded
  | BlockQuoteEncoded
  | OrderedListEncoded
  | BulletListEncoded
  | DefinitionListEncoded
  | HeaderEncoded
  | NoFieldEncoded<"HorizontalRule">
  | FigureEncoded
  | DivEncoded
  | TableEncoded
  | WorksheetEncoded
  | SlideShowEncoded;

// ============================================================================
// Suspended recursion helpers
// ============================================================================

/** `ReadonlyArray<Inline>` as a schema, deferring the recursive reference. */
const InlineArray = Schema.Array(
  Schema.suspend((): Schema.Schema<Inline, InlineEncoded> => Inline)
);
/** `ReadonlyArray<Block>` as a schema, deferring the recursive reference. */
const BlockArray = Schema.Array(
  Schema.suspend((): Schema.Schema<Block, BlockEncoded> => Block)
);

// ============================================================================
// Inline nodes
// ============================================================================

/** A run of literal text. */
export class Str extends Schema.TaggedClass<Str>()("Str", {
  text: Schema.String,
}) {}
/** Inter-word space. */
export class Space extends Schema.TaggedClass<Space>()("Space", {}) {}
/** A soft line break (a newline that may be re-wrapped). */
export class SoftBreak extends Schema.TaggedClass<SoftBreak>()("SoftBreak", {}) {}
/** A hard line break. */
export class LineBreak extends Schema.TaggedClass<LineBreak>()("LineBreak", {}) {}
/** Emphasized (italic) content. */
export class Emph extends Schema.TaggedClass<Emph>()("Emph", { content: InlineArray }) {}
/** Strongly emphasized (bold) content. */
export class Strong extends Schema.TaggedClass<Strong>()("Strong", { content: InlineArray }) {}
/** Underlined content. */
export class Underline extends Schema.TaggedClass<Underline>()("Underline", { content: InlineArray }) {}
/** Struck-out content. */
export class Strikeout extends Schema.TaggedClass<Strikeout>()("Strikeout", { content: InlineArray }) {}
/** Superscripted content. */
export class Superscript extends Schema.TaggedClass<Superscript>()("Superscript", { content: InlineArray }) {}
/** Subscripted content. */
export class Subscript extends Schema.TaggedClass<Subscript>()("Subscript", { content: InlineArray }) {}
/** Small-caps content. */
export class SmallCaps extends Schema.TaggedClass<SmallCaps>()("SmallCaps", { content: InlineArray }) {}

export const QuoteType = Schema.Literal("single", "double");
export type QuoteType = Schema.Schema.Type<typeof QuoteType>;
/** Quoted content (rendered with locale-appropriate quotation marks). */
export class Quoted extends Schema.TaggedClass<Quoted>()("Quoted", {
  quoteType: QuoteType,
  content: InlineArray,
}) {}

export const CitationMode = Schema.Literal("author-in-text", "suppress-author", "normal");
export type CitationMode = Schema.Schema.Type<typeof CitationMode>;
/** A single citation within a `Cite`. */
export class Citation extends Schema.Class<Citation>("Citation")({
  id: Schema.String,
  mode: CitationMode,
  prefix: InlineArray,
  suffix: InlineArray,
}) {}
/** A citation cluster. */
export class Cite extends Schema.TaggedClass<Cite>()("Cite", {
  citations: Schema.Array(Citation),
  content: InlineArray,
}) {}

/** Inline code span. */
export class Code extends Schema.TaggedClass<Code>()("Code", {
  attr: attrField,
  text: Schema.String,
}) {}

export const MathType = Schema.Literal("inline", "display");
export type MathType = Schema.Schema.Type<typeof MathType>;
/** Inline or display math (TeX). */
export class Math extends Schema.TaggedClass<Math>()("Math", {
  mathType: MathType,
  text: Schema.String,
}) {}

/** Raw inline content in a named target format (e.g. "html", "latex"). */
export class RawInline extends Schema.TaggedClass<RawInline>()("RawInline", {
  format: Schema.String,
  text: Schema.String,
}) {}

/** A link target: URL plus optional title. */
export const Target = Schema.Struct({
  url: Schema.String,
  title: Schema.optional(Schema.String),
});
export type Target = Schema.Schema.Type<typeof Target>;

/** A hyperlink. */
export class Link extends Schema.TaggedClass<Link>()("Link", {
  attr: attrField,
  content: InlineArray,
  target: Target,
}) {}
/** An image; `alt` is its alternate-text inlines. */
export class Image extends Schema.TaggedClass<Image>()("Image", {
  attr: attrField,
  alt: InlineArray,
  target: Target,
}) {}
/** A footnote/endnote, containing block content. */
export class Note extends Schema.TaggedClass<Note>()("Note", {
  content: BlockArray,
}) {}
/** A generic inline container carrying attributes. */
export class Span extends Schema.TaggedClass<Span>()("Span", {
  attr: attrField,
  content: InlineArray,
}) {}

/** Any inline-level node. */
export type Inline =
  | Str | Space | SoftBreak | LineBreak | Emph | Strong | Underline | Strikeout
  | Superscript | Subscript | SmallCaps | Quoted | Cite | Code | Math | RawInline
  | Link | Image | Note | Span;

export const Inline: Schema.Schema<Inline, InlineEncoded> = Schema.Union(
  Str, Space, SoftBreak, LineBreak, Emph, Strong, Underline, Strikeout,
  Superscript, Subscript, SmallCaps, Quoted, Cite, Code, Math, RawInline,
  Link, Image, Note, Span
);

// ============================================================================
// Block nodes (prose)
// ============================================================================

/** Inline content without paragraph semantics (used in tight contexts). */
export class Plain extends Schema.TaggedClass<Plain>()("Plain", { content: InlineArray }) {}
/** A paragraph. */
export class Para extends Schema.TaggedClass<Para>()("Para", { content: InlineArray }) {}
/** Lines whose breaks are significant (verse, addresses). */
export class LineBlock extends Schema.TaggedClass<LineBlock>()("LineBlock", {
  lines: Schema.Array(InlineArray),
}) {}
/** A block of preformatted code. */
export class CodeBlock extends Schema.TaggedClass<CodeBlock>()("CodeBlock", {
  attr: attrField,
  text: Schema.String,
  language: Schema.optional(Schema.String),
}) {}
/** Raw block content in a named target format. */
export class RawBlock extends Schema.TaggedClass<RawBlock>()("RawBlock", {
  format: Schema.String,
  text: Schema.String,
}) {}
/** A block quotation. */
export class BlockQuote extends Schema.TaggedClass<BlockQuote>()("BlockQuote", {
  content: BlockArray,
}) {}

export const ListNumberStyle = Schema.Literal(
  "default", "example", "decimal", "lower-roman", "upper-roman", "lower-alpha", "upper-alpha"
);
export type ListNumberStyle = Schema.Schema.Type<typeof ListNumberStyle>;
export const ListNumberDelim = Schema.Literal("default", "period", "one-paren", "two-parens");
export type ListNumberDelim = Schema.Schema.Type<typeof ListNumberDelim>;

/** An ordered (numbered) list; each item is a sequence of blocks. */
export class OrderedList extends Schema.TaggedClass<OrderedList>()("OrderedList", {
  attr: attrField,
  start: Schema.optional(Schema.Number),
  numberStyle: Schema.optional(ListNumberStyle),
  numberDelim: Schema.optional(ListNumberDelim),
  items: Schema.Array(BlockArray),
}) {}
/** A bullet (unordered) list. */
export class BulletList extends Schema.TaggedClass<BulletList>()("BulletList", {
  attr: attrField,
  items: Schema.Array(BlockArray),
}) {}

/** A term-with-definitions entry in a definition list. */
export class DefinitionItem extends Schema.Class<DefinitionItem>("DefinitionItem")({
  term: InlineArray,
  definitions: Schema.Array(BlockArray),
}) {}
/** A definition list. */
export class DefinitionList extends Schema.TaggedClass<DefinitionList>()("DefinitionList", {
  attr: attrField,
  items: Schema.Array(DefinitionItem),
}) {}

/** A section heading (level 1-6). */
export class Header extends Schema.TaggedClass<Header>()("Header", {
  level: Schema.Number.pipe(Schema.int(), Schema.between(1, 6)),
  attr: attrField,
  content: InlineArray,
}) {}
/** A horizontal rule / thematic break. */
export class HorizontalRule extends Schema.TaggedClass<HorizontalRule>()("HorizontalRule", {}) {}
/** A figure: block content plus a caption. */
export class Figure extends Schema.TaggedClass<Figure>()("Figure", {
  attr: attrField,
  caption: BlockArray,
  content: BlockArray,
}) {}
/** A generic block container carrying attributes. */
export class Div extends Schema.TaggedClass<Div>()("Div", {
  attr: attrField,
  content: BlockArray,
}) {}

// ---- prose table ----------------------------------------------------------

export const ColWidth = Schema.NullOr(Schema.Number);
/** A column specification: alignment and relative width. */
export class ColSpec extends Schema.Class<ColSpec>("ColSpec")({
  align: Schema.optional(Schema.Literal("left", "right", "center", "default")),
  width: Schema.optional(ColWidth),
}) {}
/** A prose table cell, holding block content (Pandoc style). */
export class TableCell extends Schema.Class<TableCell>("TableCell")({
  attr: attrField,
  align: Schema.optional(Schema.Literal("left", "right", "center", "default")),
  rowSpan: Schema.optional(Schema.Number),
  colSpan: Schema.optional(Schema.Number),
  content: BlockArray,
}) {}
/** A row of prose-table cells. */
export class TableRow extends Schema.Class<TableRow>("TableRow")({
  cells: Schema.Array(TableCell),
}) {}
/** A prose table: caption, column specs, and head/body/foot rows. */
export class Table extends Schema.TaggedClass<Table>()("Table", {
  attr: attrField,
  caption: Schema.optional(InlineArray),
  colSpecs: Schema.Array(ColSpec),
  head: Schema.Array(TableRow),
  body: Schema.Array(TableRow),
  foot: Schema.Array(TableRow),
}) {}

// ============================================================================
// Spreadsheet nodes
// ============================================================================

const styleField = Schema.optional(Style);

/** A text cell. */
export class CellText extends Schema.TaggedClass<CellText>()("CellText", {
  value: Schema.String,
  style: styleField,
}) {}
/** A numeric cell. */
export class CellNumber extends Schema.TaggedClass<CellNumber>()("CellNumber", {
  value: Schema.Number,
  style: styleField,
}) {}
/** A boolean cell. */
export class CellBoolean extends Schema.TaggedClass<CellBoolean>()("CellBoolean", {
  value: Schema.Boolean,
  style: styleField,
}) {}
/** A date/time cell (a genuine date value, distinct from a number). */
export class CellDate extends Schema.TaggedClass<CellDate>()("CellDate", {
  value: Schema.Date,
  style: styleField,
}) {}
/** An error cell (carries the error literal, e.g. "#DIV/0!"). */
export class CellError extends Schema.TaggedClass<CellError>()("CellError", {
  value: Schema.String,
  style: styleField,
}) {}
/** An empty cell. */
export class CellBlank extends Schema.TaggedClass<CellBlank>()("CellBlank", {
  style: styleField,
}) {}
/** A formula cell: the expression plus an optional cached result string. */
export class CellFormula extends Schema.TaggedClass<CellFormula>()("CellFormula", {
  formula: Schema.String,
  result: Schema.optional(Schema.String),
  style: styleField,
}) {}
/** A rich-text cell with character-level formatting (inline runs). */
export class CellRichText extends Schema.TaggedClass<CellRichText>()("CellRichText", {
  runs: InlineArray,
  style: styleField,
}) {}

/** Any typed spreadsheet cell. */
export type SheetCell =
  | CellText | CellNumber | CellBoolean | CellDate | CellError | CellBlank
  | CellFormula | CellRichText;
export const SheetCell: Schema.Schema<SheetCell, SheetCellEncoded> = Schema.Union(
  CellText, CellNumber, CellBoolean, CellDate, CellError, CellBlank, CellFormula, CellRichText
);

/** A column definition (width / default style). */
export class SheetColumn extends Schema.Class<SheetColumn>("SheetColumn")({
  width: Schema.optional(Schema.Number),
  style: styleField,
}) {}
/** A spreadsheet row of cells. */
export class SheetRow extends Schema.Class<SheetRow>("SheetRow")({
  cells: Schema.Array(SheetCell),
  height: Schema.optional(Schema.Number),
}) {}
/** A rectangular merged-cell range (0-based, inclusive). */
export class MergeRange extends Schema.Class<MergeRange>("MergeRange")({
  fromRow: Schema.Number,
  fromCol: Schema.Number,
  toRow: Schema.Number,
  toCol: Schema.Number,
}) {}
/** A spreadsheet worksheet: a named grid of typed cells. */
export class Worksheet extends Schema.TaggedClass<Worksheet>()("Worksheet", {
  attr: attrField,
  name: Schema.String,
  columns: Schema.Array(SheetColumn),
  rows: Schema.Array(SheetRow),
  merges: Schema.Array(MergeRange),
}) {}

// ============================================================================
// Presentation nodes
// ============================================================================

/** A text box shape. */
export class TextBox extends Schema.TaggedClass<TextBox>()("TextBox", {
  attr: attrField,
  content: BlockArray,
}) {}
/** A picture shape. */
export class Picture extends Schema.TaggedClass<Picture>()("Picture", {
  attr: attrField,
  src: Schema.String,
  alt: Schema.optional(Schema.String),
}) {}
/** A table shape (wraps a prose `Table`). */
export class TableShape extends Schema.TaggedClass<TableShape>()("TableShape", {
  attr: attrField,
  table: Schema.suspend((): Schema.Schema<Table, TableEncoded> => Table),
}) {}
/** A layout placeholder shape (title, body, ...). */
export class Placeholder extends Schema.TaggedClass<Placeholder>()("Placeholder", {
  attr: attrField,
  placeholderType: Schema.String,
  idx: Schema.optional(Schema.Number),
  content: BlockArray,
}) {}

/** Any slide shape. */
export type Shape = TextBox | Picture | TableShape | Placeholder;
export const Shape: Schema.Schema<Shape, ShapeEncoded> = Schema.Union(
  TextBox, Picture, TableShape, Placeholder
);

/** A single slide: shapes plus optional speaker notes. */
export class Slide extends Schema.Class<Slide>("Slide")({
  attr: attrField,
  layout: Schema.optional(Schema.String),
  shapes: Schema.Array(Shape),
  notes: Schema.optional(BlockArray),
}) {}
/** Deck-level geometry (EMU or px, by convention of the producing format). */
export class SlideSize extends Schema.Class<SlideSize>("SlideSize")({
  width: Schema.Number,
  height: Schema.Number,
}) {}
/** A presentation deck: ordered slides plus deck geometry. */
export class SlideShow extends Schema.TaggedClass<SlideShow>()("SlideShow", {
  attr: attrField,
  size: Schema.optional(SlideSize),
  slides: Schema.Array(Slide),
}) {}

// ============================================================================
// Block union
// ============================================================================

/** Any block-level node (prose, spreadsheet, or presentation). */
export type Block =
  | Plain | Para | LineBlock | CodeBlock | RawBlock | BlockQuote | OrderedList
  | BulletList | DefinitionList | Header | HorizontalRule | Figure | Div | Table
  | Worksheet | SlideShow;

export const Block: Schema.Schema<Block, BlockEncoded> = Schema.Union(
  Plain, Para, LineBlock, CodeBlock, RawBlock, BlockQuote, OrderedList,
  BulletList, DefinitionList, Header, HorizontalRule, Figure, Div, Table,
  Worksheet, SlideShow
);
