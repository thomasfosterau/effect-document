/**
 * Features are the atoms of the profile/subset system.
 *
 * Every capability a document can use - a node kind, a cell value type, an
 * attribute facet - is named by a string-literal `Feature`. A "profile" is just
 * a set of allowed features (see `../profile`), and the document type is
 * phantom-tagged with the union of features it is permitted to contain, so that
 * "subset of" becomes ordinary TypeScript assignability.
 *
 * This module is dependency-free on purpose: both the schema and the profile
 * layers import it, so it must not import either.
 */

// ============================================================================
// Feature taxonomy
// ============================================================================

/** Inline-level node features (prose). */
export type InlineFeature =
  | "inline.str"
  | "inline.space"
  | "inline.softBreak"
  | "inline.lineBreak"
  | "inline.emph"
  | "inline.strong"
  | "inline.underline"
  | "inline.strikeout"
  | "inline.superscript"
  | "inline.subscript"
  | "inline.smallCaps"
  | "inline.quoted"
  | "inline.cite"
  | "inline.code"
  | "inline.math"
  | "inline.rawInline"
  | "inline.link"
  | "inline.image"
  | "inline.note"
  | "inline.span";

/** Block-level node features (prose). */
export type BlockFeature =
  | "block.plain"
  | "block.para"
  | "block.lineBlock"
  | "block.codeBlock"
  | "block.rawBlock"
  | "block.blockQuote"
  | "block.orderedList"
  | "block.bulletList"
  | "block.definitionList"
  | "block.header"
  | "block.horizontalRule"
  | "block.figure"
  | "block.div"
  | "block.table";

/** Spreadsheet features (the `Worksheet` block and its typed cells). */
export type SheetFeature =
  | "sheet.worksheet"
  | "sheet.multiple"
  | "sheet.merges"
  | "sheet.columns"
  | "cell.text"
  | "cell.number"
  | "cell.boolean"
  | "cell.date"
  | "cell.error"
  | "cell.blank"
  | "cell.formula"
  | "cell.richText"
  | "cell.style";

/** Presentation features (the `SlideShow` block, its slides and shapes). */
export type DeckFeature =
  | "deck.slideShow"
  | "deck.notes"
  | "shape.textBox"
  | "shape.picture"
  | "shape.table"
  | "shape.placeholder";

/** Cross-cutting attribute-facet features (which kinds of `Attributes` are allowed). */
export type AttrFeature = "attr.id" | "attr.classes" | "attr.keyValue" | "attr.style";

/** Any capability the universal document schema can express. */
export type Feature = InlineFeature | BlockFeature | SheetFeature | DeckFeature | AttrFeature;

// ============================================================================
// Tag -> feature map
// ============================================================================

/**
 * Maps a node's `_tag` to the feature it represents. Cells, shapes and the
 * document-level capabilities (multiple sheets, merges, attribute facets) are
 * derived separately during a tree walk - see `../profile/collect`.
 */
export const TAG_FEATURE = {
  // inlines
  Str: "inline.str",
  Space: "inline.space",
  SoftBreak: "inline.softBreak",
  LineBreak: "inline.lineBreak",
  Emph: "inline.emph",
  Strong: "inline.strong",
  Underline: "inline.underline",
  Strikeout: "inline.strikeout",
  Superscript: "inline.superscript",
  Subscript: "inline.subscript",
  SmallCaps: "inline.smallCaps",
  Quoted: "inline.quoted",
  Cite: "inline.cite",
  Code: "inline.code",
  Math: "inline.math",
  RawInline: "inline.rawInline",
  Link: "inline.link",
  Image: "inline.image",
  Note: "inline.note",
  Span: "inline.span",
  // blocks
  Plain: "block.plain",
  Para: "block.para",
  LineBlock: "block.lineBlock",
  CodeBlock: "block.codeBlock",
  RawBlock: "block.rawBlock",
  BlockQuote: "block.blockQuote",
  OrderedList: "block.orderedList",
  BulletList: "block.bulletList",
  DefinitionList: "block.definitionList",
  Header: "block.header",
  HorizontalRule: "block.horizontalRule",
  Figure: "block.figure",
  Div: "block.div",
  Table: "block.table",
  Worksheet: "sheet.worksheet",
  SlideShow: "deck.slideShow",
  // spreadsheet cell values
  CellText: "cell.text",
  CellNumber: "cell.number",
  CellBoolean: "cell.boolean",
  CellDate: "cell.date",
  CellError: "cell.error",
  CellBlank: "cell.blank",
  CellFormula: "cell.formula",
  CellRichText: "cell.richText",
  // presentation shapes
  TextBox: "shape.textBox",
  Picture: "shape.picture",
  TableShape: "shape.table",
  Placeholder: "shape.placeholder",
} as const satisfies Record<string, Feature>;

/**
 * The node tags whose feature is one of `F`: the kinds of node a document of
 * a profile with features `F` may contain. `TagsOf<"block.para" | "cell.text">`
 * is `"Para" | "CellText"`.
 */
export type TagsOf<F extends Feature> = {
  readonly [T in keyof typeof TAG_FEATURE]: (typeof TAG_FEATURE)[T] extends F ? T : never;
}[keyof typeof TAG_FEATURE];

/** Any document node whose tag {@link TAG_FEATURE} maps to a feature. */
export type TaggedNode = { readonly _tag: keyof typeof TAG_FEATURE };

/** A by-name view of {@link TAG_FEATURE} for looking up arbitrary tags. */
interface TagFeatureLookup {
  readonly [tag: string]: Feature | undefined;
}

const tagFeatureLookup: TagFeatureLookup = TAG_FEATURE;

/** The feature represented by a node's tag, if the tag is mapped. */
export const featureOfTag = (tag: string): Feature | undefined => tagFeatureLookup[tag];

// ============================================================================
// Feature groups (handy when assembling profiles)
// ============================================================================

/** Every inline feature, for assembling profiles. */
export const ALL_INLINE_FEATURES: ReadonlyArray<InlineFeature> = [
  "inline.str",
  "inline.space",
  "inline.softBreak",
  "inline.lineBreak",
  "inline.emph",
  "inline.strong",
  "inline.underline",
  "inline.strikeout",
  "inline.superscript",
  "inline.subscript",
  "inline.smallCaps",
  "inline.quoted",
  "inline.cite",
  "inline.code",
  "inline.math",
  "inline.rawInline",
  "inline.link",
  "inline.image",
  "inline.note",
  "inline.span",
];

/** Every prose block feature, for assembling profiles. */
export const ALL_BLOCK_FEATURES: ReadonlyArray<BlockFeature> = [
  "block.plain",
  "block.para",
  "block.lineBlock",
  "block.codeBlock",
  "block.rawBlock",
  "block.blockQuote",
  "block.orderedList",
  "block.bulletList",
  "block.definitionList",
  "block.header",
  "block.horizontalRule",
  "block.figure",
  "block.div",
  "block.table",
];

/** Every spreadsheet feature (worksheets and cell types), for assembling profiles. */
export const ALL_SHEET_FEATURES: ReadonlyArray<SheetFeature> = [
  "sheet.worksheet",
  "sheet.multiple",
  "sheet.merges",
  "sheet.columns",
  "cell.text",
  "cell.number",
  "cell.boolean",
  "cell.date",
  "cell.error",
  "cell.blank",
  "cell.formula",
  "cell.richText",
  "cell.style",
];

/** Every presentation feature (slide shows and shapes), for assembling profiles. */
export const ALL_DECK_FEATURES: ReadonlyArray<DeckFeature> = [
  "deck.slideShow",
  "deck.notes",
  "shape.textBox",
  "shape.picture",
  "shape.table",
  "shape.placeholder",
];

/** Every attribute facet feature, for assembling profiles. */
export const ALL_ATTR_FEATURES: ReadonlyArray<AttrFeature> = [
  "attr.id",
  "attr.classes",
  "attr.keyValue",
  "attr.style",
];

/** Every feature in the schema - the maximal ("Full") profile's allow-set. */
export const ALL_FEATURES: ReadonlyArray<Feature> = [
  ...ALL_INLINE_FEATURES,
  ...ALL_BLOCK_FEATURES,
  ...ALL_SHEET_FEATURES,
  ...ALL_DECK_FEATURES,
  ...ALL_ATTR_FEATURES,
];
