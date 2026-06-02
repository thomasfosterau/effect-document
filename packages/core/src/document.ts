/**
 * The Pandoc-style document AST - the universal intermediate representation
 * for document-oriented formats.
 *
 * A Document is a list of Blocks; Blocks contain Inlines (or other Blocks,
 * in the case of table cells). All nodes are Effect Schema classes, so the
 * entire AST can be encoded to / decoded from plain JSON for free.
 */

import { Schema } from "effect";

// ============================================================================
// Encoded (plain JSON) forms - used to type recursive schema references
// ============================================================================

export interface StrEncoded {
  readonly _tag: "Str";
  readonly text: string;
}

export interface SpaceEncoded {
  readonly _tag: "Space";
}

export interface EmphEncoded {
  readonly _tag: "Emph";
  readonly content: ReadonlyArray<InlineEncoded>;
}

export interface StrongEncoded {
  readonly _tag: "Strong";
  readonly content: ReadonlyArray<InlineEncoded>;
}

export interface CodeEncoded {
  readonly _tag: "Code";
  readonly text: string;
}

export type InlineEncoded =
  | StrEncoded
  | SpaceEncoded
  | EmphEncoded
  | StrongEncoded
  | CodeEncoded;

export interface PlainEncoded {
  readonly _tag: "Plain";
  readonly content: ReadonlyArray<InlineEncoded>;
}

export interface ParagraphEncoded {
  readonly _tag: "Paragraph";
  readonly content: ReadonlyArray<InlineEncoded>;
}

export interface HeadingEncoded {
  readonly _tag: "Heading";
  readonly level: number;
  readonly content: ReadonlyArray<InlineEncoded>;
}

export interface CodeBlockEncoded {
  readonly _tag: "CodeBlock";
  readonly text: string;
  readonly language?: string;
}

export interface TableCellEncoded {
  readonly _tag: "TableCell";
  readonly content: ReadonlyArray<BlockEncoded>;
}

export interface TableRowEncoded {
  readonly cells: ReadonlyArray<TableCellEncoded>;
}

export interface TableEncoded {
  readonly _tag: "Table";
  readonly caption?: string;
  readonly head: ReadonlyArray<TableRowEncoded>;
  readonly body: ReadonlyArray<TableRowEncoded>;
}

export type BlockEncoded =
  | PlainEncoded
  | ParagraphEncoded
  | HeadingEncoded
  | CodeBlockEncoded
  | TableEncoded;

// ============================================================================
// Inline nodes
// ============================================================================

/** A run of literal text */
export class Str extends Schema.TaggedClass<Str>()("Str", {
  text: Schema.String,
}) {}

/** Inter-word space */
export class Space extends Schema.TaggedClass<Space>()("Space", {}) {}

/** Emphasized (italic) content */
export class Emph extends Schema.TaggedClass<Emph>()("Emph", {
  content: Schema.Array(
    Schema.suspend((): Schema.Schema<Inline, InlineEncoded> => Inline)
  ),
}) {}

/** Strongly emphasized (bold) content */
export class Strong extends Schema.TaggedClass<Strong>()("Strong", {
  content: Schema.Array(
    Schema.suspend((): Schema.Schema<Inline, InlineEncoded> => Inline)
  ),
}) {}

/** Inline code span */
export class Code extends Schema.TaggedClass<Code>()("Code", {
  text: Schema.String,
}) {}

/** Any inline-level node */
export type Inline = Str | Space | Emph | Strong | Code;

export const Inline: Schema.Schema<Inline, InlineEncoded> = Schema.Union(
  Str,
  Space,
  Emph,
  Strong,
  Code
);

// ============================================================================
// Block nodes
// ============================================================================

/** Plain content - inlines without paragraph semantics (used in table cells) */
export class Plain extends Schema.TaggedClass<Plain>()("Plain", {
  content: Schema.Array(Inline),
}) {}

/** A paragraph */
export class Paragraph extends Schema.TaggedClass<Paragraph>()("Paragraph", {
  content: Schema.Array(Inline),
}) {}

/** A section heading (level 1-6) */
export class Heading extends Schema.TaggedClass<Heading>()("Heading", {
  level: Schema.Number.pipe(Schema.int(), Schema.between(1, 6)),
  content: Schema.Array(Inline),
}) {}

/** A block of preformatted code */
export class CodeBlock extends Schema.TaggedClass<CodeBlock>()("CodeBlock", {
  text: Schema.String,
  language: Schema.optional(Schema.String),
}) {}

/** A single table cell, containing block-level content (Pandoc style) */
export class TableCell extends Schema.TaggedClass<TableCell>()("TableCell", {
  content: Schema.Array(
    Schema.suspend((): Schema.Schema<Block, BlockEncoded> => Block)
  ),
}) {}

/** A row of table cells */
export class TableRow extends Schema.Class<TableRow>("TableRow")({
  cells: Schema.Array(TableCell),
}) {}

/** A table block with optional caption, header rows, and body rows */
export class Table extends Schema.TaggedClass<Table>()("Table", {
  caption: Schema.optional(Schema.String),
  head: Schema.Array(TableRow),
  body: Schema.Array(TableRow),
}) {}

/** Any block-level node */
export type Block = Plain | Paragraph | Heading | CodeBlock | Table;

export const Block: Schema.Schema<Block, BlockEncoded> = Schema.Union(
  Plain,
  Paragraph,
  Heading,
  CodeBlock,
  Table
);

// ============================================================================
// Document
// ============================================================================

/** Document metadata (title, author, arbitrary key/values) */
export const Meta = Schema.Record({ key: Schema.String, value: Schema.Unknown });

/** A complete document: metadata plus a sequence of blocks */
export class Document extends Schema.Class<Document>("Document")({
  meta: Meta,
  blocks: Schema.Array(Block),
}) {}

// ============================================================================
// Constructors & utilities
// ============================================================================

/** Construct a Str inline */
export const str = (text: string): Str => new Str({ text });

/** Construct a Plain block containing a single text run */
export const plainText = (text: string): Plain =>
  new Plain({ content: [new Str({ text })] });

/** Construct a document from blocks (with optional metadata) */
export const document = (
  blocks: ReadonlyArray<Block>,
  meta: Readonly<Record<string, unknown>> = {}
): Document => new Document({ meta, blocks });

/** Collapse a sequence of inlines into plain text */
export const inlinesToText = (inlines: ReadonlyArray<Inline>): string =>
  inlines
    .map((inline): string => {
      switch (inline._tag) {
        case "Str":
          return inline.text;
        case "Space":
          return " ";
        case "Code":
          return inline.text;
        case "Emph":
        case "Strong":
          return inlinesToText(inline.content);
      }
    })
    .join("");

/** Collapse a sequence of blocks into plain text (one line per block) */
export const blocksToText = (blocks: ReadonlyArray<Block>): string =>
  blocks
    .map((block): string => {
      switch (block._tag) {
        case "Plain":
        case "Paragraph":
        case "Heading":
          return inlinesToText(block.content);
        case "CodeBlock":
          return block.text;
        case "Table":
          // Nested tables are not flattened to text
          return "";
      }
    })
    .join("\n");
