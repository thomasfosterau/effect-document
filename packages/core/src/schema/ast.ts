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

import * as Schema from "effect/Schema";
import { Attributes, Style, attrField } from "./attributes.ts";

// ============================================================================
// Encoded (plain JSON) forms
// ============================================================================

type Attrs = Attributes; // attr encodes 1:1 (no Date/class-valued fields)
type CellAlign = "left" | "right" | "center" | "default";
type NumberStyle =
  | "default"
  | "example"
  | "decimal"
  | "lower-roman"
  | "upper-roman"
  | "lower-alpha"
  | "upper-alpha";
type NumberDelim = "default" | "period" | "one-paren" | "two-parens";

interface WrapInlineEncoded<T extends string> {
  readonly _tag: T;
  readonly content: ReadonlyArray<InlineEncoded>;
}

/** The JSON (encoded) form of {@link Str}. */
export interface StrEncoded {
  readonly _tag: "Str";
  readonly text: string;
}
/** The JSON (encoded) form of a node with no fields (`Space`, `SoftBreak`, `LineBreak`, …). */
export interface NoFieldEncoded<T extends string> {
  readonly _tag: T;
}
/** The JSON (encoded) form of {@link Quoted}. */
export interface QuotedEncoded {
  readonly _tag: "Quoted";
  readonly quoteType: "single" | "double";
  readonly content: ReadonlyArray<InlineEncoded>;
}
/** The JSON (encoded) form of {@link Citation}. */
export interface CitationEncoded {
  readonly id: string;
  readonly mode: "author-in-text" | "suppress-author" | "normal";
  readonly prefix: ReadonlyArray<InlineEncoded>;
  readonly suffix: ReadonlyArray<InlineEncoded>;
}
/** The JSON (encoded) form of {@link Cite}. */
export interface CiteEncoded {
  readonly _tag: "Cite";
  readonly citations: ReadonlyArray<CitationEncoded>;
  readonly content: ReadonlyArray<InlineEncoded>;
}
/** The JSON (encoded) form of {@link Code}. */
export interface CodeEncoded {
  readonly _tag: "Code";
  readonly attr?: Attrs | undefined;
  readonly text: string;
}
/** The JSON (encoded) form of {@link Math}. */
export interface MathEncoded {
  readonly _tag: "Math";
  readonly mathType: "inline" | "display";
  readonly text: string;
}
/** The JSON (encoded) form of {@link RawInline}. */
export interface RawInlineEncoded {
  readonly _tag: "RawInline";
  readonly format: string;
  readonly text: string;
}
/** The JSON (encoded) form of {@link Target}. */
export interface TargetEncoded {
  readonly url: string;
  readonly title?: string | undefined;
}
/** The JSON (encoded) form of {@link Link}. */
export interface LinkEncoded {
  readonly _tag: "Link";
  readonly attr?: Attrs | undefined;
  readonly content: ReadonlyArray<InlineEncoded>;
  readonly target: TargetEncoded;
}
/** The JSON (encoded) form of {@link Image}. */
export interface ImageEncoded {
  readonly _tag: "Image";
  readonly attr?: Attrs | undefined;
  readonly alt: ReadonlyArray<InlineEncoded>;
  readonly target: TargetEncoded;
}
/** The JSON (encoded) form of {@link Note}. */
export interface NoteEncoded {
  readonly _tag: "Note";
  readonly content: ReadonlyArray<BlockEncoded>;
}
/** The JSON (encoded) form of {@link Span}. */
export interface SpanEncoded {
  readonly _tag: "Span";
  readonly attr?: Attrs | undefined;
  readonly content: ReadonlyArray<InlineEncoded>;
}

/** The JSON (encoded) form of {@link Inline}. */
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

/** The JSON (encoded) form of {@link Plain}. */
export interface PlainEncoded {
  readonly _tag: "Plain";
  readonly content: ReadonlyArray<InlineEncoded>;
}
/** The JSON (encoded) form of {@link Para}. */
export interface ParaEncoded {
  readonly _tag: "Para";
  readonly content: ReadonlyArray<InlineEncoded>;
}
/** The JSON (encoded) form of {@link LineBlock}. */
export interface LineBlockEncoded {
  readonly _tag: "LineBlock";
  readonly lines: ReadonlyArray<ReadonlyArray<InlineEncoded>>;
}
/** The JSON (encoded) form of {@link CodeBlock}. */
export interface CodeBlockEncoded {
  readonly _tag: "CodeBlock";
  readonly attr?: Attrs | undefined;
  readonly text: string;
  readonly language?: string | undefined;
}
/** The JSON (encoded) form of {@link RawBlock}. */
export interface RawBlockEncoded {
  readonly _tag: "RawBlock";
  readonly format: string;
  readonly text: string;
}
/** The JSON (encoded) form of {@link BlockQuote}. */
export interface BlockQuoteEncoded {
  readonly _tag: "BlockQuote";
  readonly content: ReadonlyArray<BlockEncoded>;
}
/** The JSON (encoded) form of {@link OrderedList}. */
export interface OrderedListEncoded {
  readonly _tag: "OrderedList";
  readonly attr?: Attrs | undefined;
  readonly start?: number | undefined;
  readonly numberStyle?: NumberStyle | undefined;
  readonly numberDelim?: NumberDelim | undefined;
  readonly items: ReadonlyArray<ReadonlyArray<BlockEncoded>>;
}
/** The JSON (encoded) form of {@link BulletList}. */
export interface BulletListEncoded {
  readonly _tag: "BulletList";
  readonly attr?: Attrs | undefined;
  readonly items: ReadonlyArray<ReadonlyArray<BlockEncoded>>;
}
/** The JSON (encoded) form of {@link DefinitionItem}. */
export interface DefinitionItemEncoded {
  readonly term: ReadonlyArray<InlineEncoded>;
  readonly definitions: ReadonlyArray<ReadonlyArray<BlockEncoded>>;
}
/** The JSON (encoded) form of {@link DefinitionList}. */
export interface DefinitionListEncoded {
  readonly _tag: "DefinitionList";
  readonly attr?: Attrs | undefined;
  readonly items: ReadonlyArray<DefinitionItemEncoded>;
}
/** The JSON (encoded) form of {@link Header}. */
export interface HeaderEncoded {
  readonly _tag: "Header";
  readonly level: number;
  readonly attr?: Attrs | undefined;
  readonly content: ReadonlyArray<InlineEncoded>;
}
/** The JSON (encoded) form of {@link Figure}. */
export interface FigureEncoded {
  readonly _tag: "Figure";
  readonly attr?: Attrs | undefined;
  readonly caption: ReadonlyArray<BlockEncoded>;
  readonly content: ReadonlyArray<BlockEncoded>;
}
/** The JSON (encoded) form of {@link Div}. */
export interface DivEncoded {
  readonly _tag: "Div";
  readonly attr?: Attrs | undefined;
  readonly content: ReadonlyArray<BlockEncoded>;
}
/** The JSON (encoded) form of {@link ColSpec}. */
export interface ColSpecEncoded {
  readonly align?: CellAlign | undefined;
  readonly width?: number | null | undefined;
}
/** The JSON (encoded) form of {@link TableCell}. */
export interface TableCellEncoded {
  readonly attr?: Attrs | undefined;
  readonly align?: CellAlign | undefined;
  readonly rowSpan?: number | undefined;
  readonly colSpan?: number | undefined;
  readonly content: ReadonlyArray<BlockEncoded>;
}
/** The JSON (encoded) form of {@link TableRow}. */
export interface TableRowEncoded {
  readonly cells: ReadonlyArray<TableCellEncoded>;
}
/** The JSON (encoded) form of {@link Table}. */
export interface TableEncoded {
  readonly _tag: "Table";
  readonly attr?: Attrs | undefined;
  readonly caption?: ReadonlyArray<InlineEncoded> | undefined;
  readonly colSpecs: ReadonlyArray<ColSpecEncoded>;
  readonly head: ReadonlyArray<TableRowEncoded>;
  readonly body: ReadonlyArray<TableRowEncoded>;
  readonly foot: ReadonlyArray<TableRowEncoded>;
}

// Spreadsheet encoded forms
type StyleE = Style;
/** The JSON (encoded) form of {@link CellText}. */
export interface CellTextEncoded {
  readonly _tag: "CellText";
  readonly value: string;
  readonly style?: StyleE | undefined;
}
/** The JSON (encoded) form of {@link CellNumber}. */
export interface CellNumberEncoded {
  readonly _tag: "CellNumber";
  readonly value: number;
  readonly style?: StyleE | undefined;
}
/** The JSON (encoded) form of {@link CellBoolean}. */
export interface CellBooleanEncoded {
  readonly _tag: "CellBoolean";
  readonly value: boolean;
  readonly style?: StyleE | undefined;
}
/** The JSON (encoded) form of {@link CellDate}. */
export interface CellDateEncoded {
  readonly _tag: "CellDate";
  readonly value: string; // ISO-8601 (Date encodes to string)
  readonly style?: StyleE | undefined;
}
/** The JSON (encoded) form of {@link CellError}. */
export interface CellErrorEncoded {
  readonly _tag: "CellError";
  readonly value: string;
  readonly style?: StyleE | undefined;
}
/** The JSON (encoded) form of {@link CellBlank}. */
export interface CellBlankEncoded {
  readonly _tag: "CellBlank";
  readonly style?: StyleE | undefined;
}
/** The JSON (encoded) form of {@link CellFormula}. */
export interface CellFormulaEncoded {
  readonly _tag: "CellFormula";
  readonly formula: string;
  readonly result?: string | undefined;
  readonly style?: StyleE | undefined;
}
/** The JSON (encoded) form of {@link CellRichText}. */
export interface CellRichTextEncoded {
  readonly _tag: "CellRichText";
  readonly runs: ReadonlyArray<InlineEncoded>;
  readonly style?: StyleE | undefined;
}
/** The JSON (encoded) form of {@link SheetCell}. */
export type SheetCellEncoded =
  | CellTextEncoded
  | CellNumberEncoded
  | CellBooleanEncoded
  | CellDateEncoded
  | CellErrorEncoded
  | CellBlankEncoded
  | CellFormulaEncoded
  | CellRichTextEncoded;
/** The JSON (encoded) form of {@link SheetColumn}. */
export interface SheetColumnEncoded {
  readonly width?: number | undefined;
  readonly style?: StyleE | undefined;
}
/** The JSON (encoded) form of {@link IndexedCell}. */
export interface IndexedCellEncoded {
  readonly col: number;
  readonly cell: SheetCellEncoded;
}
/** The JSON (encoded) form of {@link SheetRow}. */
export interface SheetRowEncoded {
  readonly index: number;
  readonly cells: ReadonlyArray<IndexedCellEncoded>;
  readonly height?: number | undefined;
}
/** The JSON (encoded) form of {@link MergeRange}. */
export interface MergeRangeEncoded {
  readonly fromRow: number;
  readonly fromCol: number;
  readonly toRow: number;
  readonly toCol: number;
}
/** The JSON (encoded) form of {@link Worksheet}. */
export interface WorksheetEncoded {
  readonly _tag: "Worksheet";
  readonly attr?: Attrs | undefined;
  readonly name: string;
  readonly columns: ReadonlyArray<SheetColumnEncoded>;
  readonly rows: ReadonlyArray<SheetRowEncoded>;
  readonly merges: ReadonlyArray<MergeRangeEncoded>;
}

// Presentation encoded forms
/** The JSON (encoded) form of {@link TextBox}. */
export interface TextBoxEncoded {
  readonly _tag: "TextBox";
  readonly attr?: Attrs | undefined;
  readonly content: ReadonlyArray<BlockEncoded>;
}
/** The JSON (encoded) form of {@link Picture}. */
export interface PictureEncoded {
  readonly _tag: "Picture";
  readonly attr?: Attrs | undefined;
  readonly src: string;
  readonly alt?: string | undefined;
}
/** The JSON (encoded) form of {@link TableShape}. */
export interface TableShapeEncoded {
  readonly _tag: "TableShape";
  readonly attr?: Attrs | undefined;
  readonly table: TableEncoded;
}
/** The JSON (encoded) form of {@link Placeholder}. */
export interface PlaceholderEncoded {
  readonly _tag: "Placeholder";
  readonly attr?: Attrs | undefined;
  readonly placeholderType: string;
  readonly idx?: number | undefined;
  readonly content: ReadonlyArray<BlockEncoded>;
}
/** The JSON (encoded) form of {@link Shape}. */
export type ShapeEncoded = TextBoxEncoded | PictureEncoded | TableShapeEncoded | PlaceholderEncoded;
/** The JSON (encoded) form of {@link Slide}. */
export interface SlideEncoded {
  readonly attr?: Attrs | undefined;
  readonly layout?: string | undefined;
  readonly shapes: ReadonlyArray<ShapeEncoded>;
  readonly notes?: ReadonlyArray<BlockEncoded> | undefined;
}
/** The JSON (encoded) form of {@link SlideSize}. */
export interface SlideSizeEncoded {
  readonly width: number;
  readonly height: number;
}
/** The JSON (encoded) form of {@link SlideShow}. */
export interface SlideShowEncoded {
  readonly _tag: "SlideShow";
  readonly attr?: Attrs | undefined;
  readonly size?: SlideSizeEncoded | undefined;
  readonly slides: ReadonlyArray<SlideEncoded>;
}

/** The JSON (encoded) form of {@link Block}. */
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
const InlineArray = Schema.Array(Schema.suspend((): Schema.Codec<Inline, InlineEncoded> => Inline));
/** `ReadonlyArray<Block>` as a schema, deferring the recursive reference. */
const BlockArray = Schema.Array(Schema.suspend((): Schema.Codec<Block, BlockEncoded> => Block));

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
export class Underline extends Schema.TaggedClass<Underline>()("Underline", {
  content: InlineArray,
}) {}
/** Struck-out content. */
export class Strikeout extends Schema.TaggedClass<Strikeout>()("Strikeout", {
  content: InlineArray,
}) {}
/** Superscripted content. */
export class Superscript extends Schema.TaggedClass<Superscript>()("Superscript", {
  content: InlineArray,
}) {}
/** Subscripted content. */
export class Subscript extends Schema.TaggedClass<Subscript>()("Subscript", {
  content: InlineArray,
}) {}
/** Small-caps content. */
export class SmallCaps extends Schema.TaggedClass<SmallCaps>()("SmallCaps", {
  content: InlineArray,
}) {}

/** Which quotation marks a `Quoted` inline uses. */
export const QuoteType = Schema.Literals(["single", "double"]);
export type QuoteType = Schema.Schema.Type<typeof QuoteType>;
/** Quoted content (rendered with locale-appropriate quotation marks). */
export class Quoted extends Schema.TaggedClass<Quoted>()("Quoted", {
  quoteType: QuoteType,
  content: InlineArray,
}) {}

/** How a citation renders: author in the text, author suppressed, or the normal form (Pandoc `CitationMode`). */
export const CitationMode = Schema.Literals(["author-in-text", "suppress-author", "normal"]);
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

/** Whether a `Math` inline is set inline or as display math. */
export const MathType = Schema.Literals(["inline", "display"]);
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
  | Str
  | Space
  | SoftBreak
  | LineBreak
  | Emph
  | Strong
  | Underline
  | Strikeout
  | Superscript
  | Subscript
  | SmallCaps
  | Quoted
  | Cite
  | Code
  | Math
  | RawInline
  | Link
  | Image
  | Note
  | Span;

export const Inline: Schema.Codec<Inline, InlineEncoded> = Schema.Union([
  Str,
  Space,
  SoftBreak,
  LineBreak,
  Emph,
  Strong,
  Underline,
  Strikeout,
  Superscript,
  Subscript,
  SmallCaps,
  Quoted,
  Cite,
  Code,
  Math,
  RawInline,
  Link,
  Image,
  Note,
  Span,
]);

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

/** The numbering style of an ordered list (Pandoc `ListNumberStyle`). */
export const ListNumberStyle = Schema.Literals([
  "default",
  "example",
  "decimal",
  "lower-roman",
  "upper-roman",
  "lower-alpha",
  "upper-alpha",
]);
export type ListNumberStyle = Schema.Schema.Type<typeof ListNumberStyle>;
/** The punctuation after an ordered list number (Pandoc `ListNumberDelim`). */
export const ListNumberDelim = Schema.Literals(["default", "period", "one-paren", "two-parens"]);
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
  level: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 6 })),
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

/** A table column width as a fraction of the text width, or `null` for the default. */
export const ColWidth = Schema.NullOr(Schema.Number);
/** A table column width as a fraction of the text width, or `null` for the default. */
export type ColWidth = typeof ColWidth.Type;
/** A column specification: alignment and relative width. */
export class ColSpec extends Schema.Class<ColSpec>("ColSpec")({
  align: Schema.optional(Schema.Literals(["left", "right", "center", "default"])),
  width: Schema.optional(ColWidth),
}) {}
/** A prose table cell, holding block content (Pandoc style). */
export class TableCell extends Schema.Class<TableCell>("TableCell")({
  attr: attrField,
  align: Schema.optional(Schema.Literals(["left", "right", "center", "default"])),
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
  value: Schema.DateFromString,
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
/**
 * A formula cell: the expression plus an optional cached result string. The
 * formula is stored without a leading `=` ("A1+1"); writers strip one if
 * present.
 */
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
  | CellText
  | CellNumber
  | CellBoolean
  | CellDate
  | CellError
  | CellBlank
  | CellFormula
  | CellRichText;
export const SheetCell: Schema.Codec<SheetCell, SheetCellEncoded> = Schema.Union([
  CellText,
  CellNumber,
  CellBoolean,
  CellDate,
  CellError,
  CellBlank,
  CellFormula,
  CellRichText,
]);

/** A column definition (width / default style). */
export class SheetColumn extends Schema.Class<SheetColumn>("SheetColumn")({
  width: Schema.optional(Schema.Number),
  style: styleField,
}) {}
/** A 0-based row or column position in a worksheet. */
const SheetIndex = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/**
 * A filter requiring an array's positions (by `key`) to be strictly
 * ascending, so each position appears once and in order.
 */
const strictlyAscending = <A>(
  key: (a: A) => number,
  what: string,
  annotations: {
    readonly identifier: string;
    readonly title: string;
    readonly description: string;
  },
) =>
  Schema.makeFilter<ReadonlyArray<A>>(
    (items) =>
      items.flatMap((item, i): Array<Schema.FilterIssue> => {
        const previous = items[i - 1];
        return previous !== undefined && key(item) <= key(previous)
          ? [{ path: [i], issue: `${what} ${key(item)} is not after ${key(previous)}` }]
          : [];
      }),
    annotations,
  );

/**
 * A cell at its 0-based column. A row holds only the cells it has, so a gap
 * between two columns is simply absent (a {@link CellBlank} is kept only when
 * a format has something to say about an empty cell, such as its style).
 */
export class IndexedCell extends Schema.Class<IndexedCell>("IndexedCell")({
  col: SheetIndex,
  cell: SheetCell,
}) {}

/**
 * A spreadsheet row: its 0-based `index` and the cells it holds, in strictly
 * ascending column order. A worksheet holds only the rows it has, so a row
 * with no cells exists only to carry a `height`. See `denseRows` for a grid.
 */
export class SheetRow extends Schema.Class<SheetRow>("SheetRow")({
  index: SheetIndex,
  cells: Schema.Array(IndexedCell).check(
    strictlyAscending((c) => c.col, "column", {
      identifier: "SheetRowCellsAscending",
      title: "cells in ascending column order",
      description: "A row's cells have strictly ascending columns: each column once, in order.",
    }),
  ),
  height: Schema.optional(Schema.Number),
}) {}
/** A rectangular merged-cell range (0-based, inclusive). */
export class MergeRange extends Schema.Class<MergeRange>("MergeRange")({
  fromRow: Schema.Number,
  fromCol: Schema.Number,
  toRow: Schema.Number,
  toCol: Schema.Number,
}) {}
/**
 * A spreadsheet worksheet: a named, sparse grid of typed cells. `rows` holds
 * only the rows that have cells (or a height), in strictly ascending `index`
 * order, so a sheet's size follows the cells it holds rather than its extent;
 * `denseRows` derives the rectangular grid when a caller wants one.
 */
export class Worksheet extends Schema.TaggedClass<Worksheet>()("Worksheet", {
  attr: attrField,
  name: Schema.String,
  columns: Schema.Array(SheetColumn),
  rows: Schema.Array(SheetRow).check(
    strictlyAscending((r) => r.index, "row", {
      identifier: "WorksheetRowsAscending",
      title: "rows in ascending index order",
      description: "A worksheet's rows have strictly ascending indexes: each row once, in order.",
    }),
  ),
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
  table: Schema.suspend((): Schema.Codec<Table, TableEncoded> => Table),
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
export const Shape: Schema.Codec<Shape, ShapeEncoded> = Schema.Union([
  TextBox,
  Picture,
  TableShape,
  Placeholder,
]);

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
  | Plain
  | Para
  | LineBlock
  | CodeBlock
  | RawBlock
  | BlockQuote
  | OrderedList
  | BulletList
  | DefinitionList
  | Header
  | HorizontalRule
  | Figure
  | Div
  | Table
  | Worksheet
  | SlideShow;

export const Block: Schema.Codec<Block, BlockEncoded> = Schema.Union([
  Plain,
  Para,
  LineBlock,
  CodeBlock,
  RawBlock,
  BlockQuote,
  OrderedList,
  BulletList,
  DefinitionList,
  Header,
  HorizontalRule,
  Figure,
  Div,
  Table,
  Worksheet,
  SlideShow,
]);
