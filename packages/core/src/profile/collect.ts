/**
 * Walks a document and reports the set of {@link Feature}s it actually uses.
 * This is the basis of profile conformance (`validate`/`is`) and of narrowing:
 * a document conforms to a profile iff every feature it uses is allowed.
 */

import { type Attributes, usedAttrFeatures } from "../schema/attributes.ts";
import {
  type Block, type Inline, type SheetCell, type Shape, type Table, type Worksheet,
  type SlideShow,
} from "../schema/ast.ts";
import { Document } from "../schema/document.ts";
import { type Feature, featureOfTag } from "../schema/feature.ts";

const attrOf = (n: unknown): Attributes | undefined =>
  (n as { readonly attr?: Attributes }).attr;

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

const walkInline = (n: Inline, acc: Set<Feature>, stack: Stack): void => {
  addTag(n._tag, acc);
  addAttr(n, acc);
  switch (n._tag) {
    case "Emph": case "Strong": case "Underline": case "Strikeout":
    case "Superscript": case "Subscript": case "SmallCaps": case "Quoted":
    case "Link": case "Span":
      pushInlines(n.content, stack);
      break;
    case "Cite":
      pushInlines(n.content, stack);
      for (const c of n.citations) {
        pushInlines(c.prefix, stack);
        pushInlines(c.suffix, stack);
      }
      break;
    case "Image":
      pushInlines(n.alt, stack);
      break;
    case "Note":
      pushBlocks(n.content, stack);
      break;
    default:
      break;
  }
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
  if (c._tag === "CellRichText") pushInlines(c.runs, stack);
};

const walkWorksheet = (w: Worksheet, acc: Set<Feature>, stack: Stack): void => {
  if (w.merges.length > 0) acc.add("sheet.merges");
  if (w.columns.length > 0) acc.add("sheet.columns");
  for (const col of w.columns) if (col.style !== undefined) acc.add("cell.style");
  for (const row of w.rows) for (const c of row.cells) walkCell(c, acc, stack);
};

const walkShape = (s: Shape, acc: Set<Feature>, stack: Stack): void => {
  addTag(s._tag, acc);
  addAttr(s, acc);
  switch (s._tag) {
    case "TextBox":
    case "Placeholder":
      pushBlocks(s.content, stack);
      break;
    case "TableShape":
      walkTable(s.table, acc, stack);
      break;
    case "Picture":
      break;
  }
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

const walkBlock = (b: Block, acc: Set<Feature>, stack: Stack): void => {
  addTag(b._tag, acc);
  addAttr(b, acc);
  switch (b._tag) {
    case "Plain": case "Para": case "Header":
      pushInlines(b.content, stack);
      break;
    case "LineBlock":
      for (const line of b.lines) pushInlines(line, stack);
      break;
    case "CodeBlock": case "RawBlock": case "HorizontalRule":
      break;
    case "BlockQuote": case "Div":
      pushBlocks(b.content, stack);
      break;
    case "Figure":
      pushBlocks(b.caption, stack);
      pushBlocks(b.content, stack);
      break;
    case "OrderedList": case "BulletList":
      for (const item of b.items) pushBlocks(item, stack);
      break;
    case "DefinitionList":
      for (const item of b.items) {
        pushInlines(item.term, stack);
        for (const def of item.definitions) pushBlocks(def, stack);
      }
      break;
    case "Table":
      walkTable(b, acc, stack);
      break;
    case "Worksheet":
      walkWorksheet(b, acc, stack);
      break;
    case "SlideShow":
      walkSlideShow(b, acc, stack);
      break;
  }
};

/** The set of features a document uses. */
export const collectFeatures = (doc: Document): Set<Feature> => {
  const acc = new Set<Feature>();
  let worksheetCount = 0;
  for (const b of doc.blocks) if (b._tag === "Worksheet") worksheetCount += 1;
  if (worksheetCount > 1) acc.add("sheet.multiple");

  const stack: Stack = [];
  pushBlocks(doc.blocks, stack);
  while (stack.length > 0) {
    const work = stack.pop()!;
    switch (work.k) {
      case "block": walkBlock(work.n, acc, stack); break;
      case "inline": walkInline(work.n, acc, stack); break;
      case "shape": walkShape(work.n, acc, stack); break;
    }
  }
  return acc;
};

/** Features the document uses that are not in `allowed`. */
export const unsupportedFeatures = (
  doc: Document,
  allowed: ReadonlySet<Feature>
): Feature[] => {
  const out: Feature[] = [];
  for (const f of collectFeatures(doc)) if (!allowed.has(f)) out.push(f);
  return out;
};
