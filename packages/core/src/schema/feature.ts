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

import * as Rec from "effect/Record";

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

/**
 * Cross-cutting attribute-facet features (which kinds of `Attributes` are
 * allowed). `attr.id` allows an id on every node; see {@link IdFeature} for
 * an id on one kind of node only.
 */
export type AttrFeature = "attr.id" | "attr.classes" | "attr.keyValue" | "attr.style";

/**
 * Per-node id facets (#184): an `attr.id` allowed on one kind of node only, for
 * a format that can carry an id there and nowhere else (DOCX keeps a heading's
 * id as a bookmark). A profile that lists `attr.id` gets every one of these
 * (see `defineProfile`), and a document's id on a node is collected as that
 * node's facet, so a profile can allow ids exactly where its format keeps them.
 */
export type IdFeature =
  | "attr.id.code"
  | "attr.id.link"
  | "attr.id.image"
  | "attr.id.span"
  | "attr.id.codeBlock"
  | "attr.id.orderedList"
  | "attr.id.bulletList"
  | "attr.id.definitionList"
  | "attr.id.header"
  | "attr.id.figure"
  | "attr.id.div"
  | "attr.id.table"
  | "attr.id.tableCell"
  | "attr.id.worksheet"
  | "attr.id.slideShow"
  | "attr.id.slide"
  | "attr.id.textBox"
  | "attr.id.picture"
  | "attr.id.tableShape"
  | "attr.id.placeholder";

/** Any capability the universal document schema can express. */
export type Feature =
  | InlineFeature
  | BlockFeature
  | SheetFeature
  | DeckFeature
  | AttrFeature
  | IdFeature;

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

/**
 * The id facet of each node that carries attributes, keyed by its tag (a table
 * cell is `TableCell`, a slide `Slide`).
 */
export const ID_FEATURE = {
  Code: "attr.id.code",
  Link: "attr.id.link",
  Image: "attr.id.image",
  Span: "attr.id.span",
  CodeBlock: "attr.id.codeBlock",
  OrderedList: "attr.id.orderedList",
  BulletList: "attr.id.bulletList",
  DefinitionList: "attr.id.definitionList",
  Header: "attr.id.header",
  Figure: "attr.id.figure",
  Div: "attr.id.div",
  Table: "attr.id.table",
  TableCell: "attr.id.tableCell",
  Worksheet: "attr.id.worksheet",
  SlideShow: "attr.id.slideShow",
  Slide: "attr.id.slide",
  TextBox: "attr.id.textBox",
  Picture: "attr.id.picture",
  TableShape: "attr.id.tableShape",
  Placeholder: "attr.id.placeholder",
} as const satisfies Record<string, IdFeature>;

/** A node's tag, as {@link ID_FEATURE} keys it. */
export type IdNode = keyof typeof ID_FEATURE;

/** A by-name view of {@link ID_FEATURE} for looking up arbitrary tags. */
interface IdFeatureLookup {
  readonly [tag: string]: IdFeature | undefined;
}

const idFeatureLookup: IdFeatureLookup = ID_FEATURE;

/** The id facet of a node with the given tag; `attr.id` itself for a tag with none of its own. */
export const idFeatureOf = (tag: string): IdFeature | "attr.id" =>
  idFeatureLookup[tag] ?? "attr.id";

/**
 * A feature set with `attr.id` standing for every {@link IdFeature}: what a
 * profile listing `attr.id` allows.
 */
export type WithIdFeatures<F extends Feature> = F | ("attr.id" extends F ? IdFeature : never);

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

/** Every per-node id facet (#184). */
export const ALL_ID_FEATURES: ReadonlyArray<IdFeature> = Rec.values(ID_FEATURE);

/** A feature list with `attr.id` expanded to every per-node id facet, as {@link WithIdFeatures} does at the type level. */
export const withIdFeatures = (features: ReadonlyArray<Feature>): ReadonlyArray<Feature> =>
  features.includes("attr.id") ? [...features, ...ALL_ID_FEATURES] : features;

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
  ...ALL_ID_FEATURES,
];
