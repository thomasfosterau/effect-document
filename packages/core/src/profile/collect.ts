/**
 * Walks a document and reports the set of {@link Feature}s it actually uses.
 * This is the basis of profile conformance (`validate`/`is`) and of narrowing:
 * a document conforms to a profile iff every feature it uses is allowed.
 */

import * as Predicate from "effect/Predicate";
import * as Arr from "effect/Array";
import { type Attributes, usedAttrFeatures } from "../schema/attributes.ts";
import {
  type Block,
  type Inline,
  type SheetCell,
  type Shape,
  type Table,
  type Worksheet,
  type SlideShow,
} from "../schema/ast.ts";
import { Document } from "../schema/document.ts";
import { type Feature, featureOfTag } from "../schema/feature.ts";
import { dispatchTag, type TagHandlers } from "./dispatch.ts";

const attrOf = (n: unknown): Attributes | undefined =>
  // SAFETY: called only on document nodes, every one of which declares `attr`
  // (when it has one) as the `attrField` schema, i.e. `Attributes | undefined`.
  (n as { readonly attr?: Attributes | undefined }).attr;

const addTag = (tag: string, acc: Set<Feature>): void => {
  const f = featureOfTag(tag);
  if (f !== undefined) acc.add(f);
};

const addAttr = (n: unknown, acc: Set<Feature>): void => {
  for (const f of usedAttrFeatures(attrOf(n))) acc.add(f);
};

// Each walk adds a node's own features and pushes its children onto an
// explicit work stack rather than recursing, so arbitrarily deep documents
// can't overflow the call stack.
type Work =
  | { readonly k: "block"; readonly n: Block }
  | { readonly k: "inline"; readonly n: Inline }
  | { readonly k: "shape"; readonly n: Shape };

type Stack = Work[];

const pushInlines = (ns: ReadonlyArray<Inline>, stack: Stack): void => {
  for (const n of ns) stack.push({ k: "inline", n });
};

const pushBlocks = (ns: ReadonlyArray<Block>, stack: Stack): void => {
  for (const n of ns) stack.push({ k: "block", n });
};

type Walk<N extends { readonly _tag: string }> = TagHandlers<N, [Set<Feature>, Stack], void>;

const inlineContent = (
  n: { readonly content: ReadonlyArray<Inline> },
  _: Set<Feature>,
  stack: Stack,
) => pushInlines(n.content, stack);
const leaf = (): void => {};

/** Push an inline's children; its own tag and attributes are recorded by `walkInline`. */
const INLINE_CHILDREN: Walk<Inline> = {
  Emph: inlineContent,
  Strong: inlineContent,
  Underline: inlineContent,
  Strikeout: inlineContent,
  Superscript: inlineContent,
  Subscript: inlineContent,
  SmallCaps: inlineContent,
  Quoted: inlineContent,
  Link: inlineContent,
  Span: inlineContent,
  Cite: (n, _, stack) => {
    pushInlines(n.content, stack);
    for (const c of n.citations) {
      pushInlines(c.prefix, stack);
      pushInlines(c.suffix, stack);
    }
  },
  Image: (n, _, stack) => pushInlines(n.alt, stack),
  Note: (n, _, stack) => pushBlocks(n.content, stack),
  Str: leaf,
  Space: leaf,
  SoftBreak: leaf,
  LineBreak: leaf,
  Code: leaf,
  Math: leaf,
  RawInline: leaf,
};

const walkInline = (n: Inline, acc: Set<Feature>, stack: Stack): void => {
  addTag(n._tag, acc);
  addAttr(n, acc);
  dispatchTag(INLINE_CHILDREN, n, acc, stack);
};

const walkTable = (t: Table, acc: Set<Feature>, stack: Stack): void => {
  if (t.caption !== undefined) pushInlines(t.caption, stack);
  const rows = [...t.head, ...t.body, ...t.foot];
  for (const row of rows) {
    for (const cellNode of row.cells) {
      addAttr(cellNode, acc);
      pushBlocks(cellNode.content, stack);
    }
  }
};

const walkCell = (c: SheetCell, acc: Set<Feature>, stack: Stack): void => {
  addTag(c._tag, acc);
  if (c.style !== undefined) acc.add("cell.style");
  if (Predicate.isTagged(c, "CellRichText")) pushInlines(c.runs, stack);
};

const walkWorksheet = (w: Worksheet, acc: Set<Feature>, stack: Stack): void => {
  if (Arr.isReadonlyArrayNonEmpty(w.merges)) acc.add("sheet.merges");
  if (Arr.isReadonlyArrayNonEmpty(w.columns)) acc.add("sheet.columns");
  for (const col of w.columns) if (col.style !== undefined) acc.add("cell.style");
  for (const row of w.rows) for (const c of row.cells) walkCell(c, acc, stack);
};

const SHAPE_CHILDREN: Walk<Shape> = {
  TextBox: (s, _, stack) => pushBlocks(s.content, stack),
  Placeholder: (s, _, stack) => pushBlocks(s.content, stack),
  TableShape: (s, acc, stack) => walkTable(s.table, acc, stack),
  Picture: leaf,
};

const walkShape = (s: Shape, acc: Set<Feature>, stack: Stack): void => {
  addTag(s._tag, acc);
  addAttr(s, acc);
  dispatchTag(SHAPE_CHILDREN, s, acc, stack);
};

const walkSlideShow = (d: SlideShow, acc: Set<Feature>, stack: Stack): void => {
  for (const sl of d.slides) {
    addAttr(sl, acc);
    if (sl.notes !== undefined) {
      acc.add("deck.notes");
      pushBlocks(sl.notes, stack);
    }
    for (const sh of sl.shapes) stack.push({ k: "shape", n: sh });
  }
};

const blockContent = (
  n: { readonly content: ReadonlyArray<Block> },
  _: Set<Feature>,
  stack: Stack,
) => pushBlocks(n.content, stack);
const listItems = (
  n: { readonly items: ReadonlyArray<ReadonlyArray<Block>> },
  _: Set<Feature>,
  stack: Stack,
) => {
  for (const item of n.items) pushBlocks(item, stack);
};

const BLOCK_CHILDREN: Walk<Block> = {
  Plain: inlineContent,
  Para: inlineContent,
  Header: inlineContent,
  LineBlock: (b, _, stack) => {
    for (const line of b.lines) pushInlines(line, stack);
  },
  CodeBlock: leaf,
  RawBlock: leaf,
  HorizontalRule: leaf,
  BlockQuote: blockContent,
  Div: blockContent,
  Figure: (b, _, stack) => {
    pushBlocks(b.caption, stack);
    pushBlocks(b.content, stack);
  },
  OrderedList: listItems,
  BulletList: listItems,
  DefinitionList: (b, _, stack) => {
    for (const item of b.items) {
      pushInlines(item.term, stack);
      for (const def of item.definitions) pushBlocks(def, stack);
    }
  },
  Table: walkTable,
  Worksheet: walkWorksheet,
  SlideShow: walkSlideShow,
};

const walkBlock = (b: Block, acc: Set<Feature>, stack: Stack): void => {
  addTag(b._tag, acc);
  addAttr(b, acc);
  dispatchTag(BLOCK_CHILDREN, b, acc, stack);
};

/** The set of features a document uses. */
export const collectFeatures = (doc: Document): Set<Feature> => {
  const acc = new Set<Feature>();
  let worksheetCount = 0;
  for (const b of doc.blocks) if (Predicate.isTagged(b, "Worksheet")) worksheetCount += 1;
  if (worksheetCount > 1) acc.add("sheet.multiple");

  const stack: Stack = [];
  pushBlocks(doc.blocks, stack);
  while (Arr.isReadonlyArrayNonEmpty(stack)) {
    const work = stack.pop()!;
    if (work.k === "block") {
      walkBlock(work.n, acc, stack);
    } else if (work.k === "inline") {
      walkInline(work.n, acc, stack);
    } else if (work.k === "shape") {
      walkShape(work.n, acc, stack);
    }
  }
  return acc;
};

/** Features the document uses that are not in `allowed`. */
export const unsupportedFeatures = (doc: Document, allowed: ReadonlySet<Feature>): Feature[] => {
  const out: Feature[] = [];
  for (const f of collectFeatures(doc)) if (!allowed.has(f)) out.push(f);
  return out;
};
