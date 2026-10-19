/**
 * Walks a document and reports the set of {@link Feature}s it actually uses.
 * This is the basis of profile conformance (`validate`/`is`) and of narrowing:
 * a document conforms to a profile iff every feature it uses is allowed.
 */

import { type Attributes, usedAttrFeatures } from "../schema/attributes.js";
import {
  type Block, type Inline, type SheetCell, type Shape, type Table, type Worksheet,
  type SlideShow,
} from "../schema/ast.js";
import { Document } from "../schema/document.js";
import { type Feature, featureOfTag } from "../schema/feature.js";

const attrOf = (n: unknown): Attributes | undefined =>
  (n as { readonly attr?: Attributes }).attr;

const addTag = (tag: string, acc: Set<Feature>): void => {
  const f = featureOfTag(tag);
  if (f !== undefined) acc.add(f);
};

const addAttr = (n: unknown, acc: Set<Feature>): void => {
  for (const f of usedAttrFeatures(attrOf(n))) acc.add(f);
};

const walkInlines = (ns: ReadonlyArray<Inline>, acc: Set<Feature>): void => {
  for (const n of ns) walkInline(n, acc);
};

const walkInline = (n: Inline, acc: Set<Feature>): void => {
  addTag(n._tag, acc);
  addAttr(n, acc);
  switch (n._tag) {
    case "Emph": case "Strong": case "Underline": case "Strikeout":
    case "Superscript": case "Subscript": case "SmallCaps": case "Quoted":
    case "Link": case "Span":
      walkInlines(n.content, acc);
      break;
    case "Cite":
      walkInlines(n.content, acc);
      for (const c of n.citations) {
        walkInlines(c.prefix, acc);
        walkInlines(c.suffix, acc);
      }
      break;
    case "Image":
      walkInlines(n.alt, acc);
      break;
    case "Note":
      walkBlocks(n.content, acc);
      break;
    default:
      break;
  }
};

const walkTable = (t: Table, acc: Set<Feature>): void => {
  if (t.caption !== undefined) walkInlines(t.caption, acc);
  const rows = [...t.head, ...t.body, ...t.foot];
  for (const row of rows) {
    for (const cellNode of row.cells) {
      addAttr(cellNode, acc);
      walkBlocks(cellNode.content, acc);
    }
  }
};

const walkCell = (c: SheetCell, acc: Set<Feature>): void => {
  addTag(c._tag, acc);
  if (c.style !== undefined) acc.add("cell.style");
  if (c._tag === "CellRichText") walkInlines(c.runs, acc);
};

const walkWorksheet = (w: Worksheet, acc: Set<Feature>): void => {
  if (w.merges.length > 0) acc.add("sheet.merges");
  if (w.columns.length > 0) acc.add("sheet.columns");
  for (const col of w.columns) if (col.style !== undefined) acc.add("cell.style");
  for (const row of w.rows) for (const c of row.cells) walkCell(c, acc);
};

const walkShape = (s: Shape, acc: Set<Feature>): void => {
  addTag(s._tag, acc);
  addAttr(s, acc);
  switch (s._tag) {
    case "TextBox":
    case "Placeholder":
      walkBlocks(s.content, acc);
      break;
    case "TableShape":
      walkTable(s.table, acc);
      break;
    case "Picture":
      break;
  }
};

const walkSlideShow = (d: SlideShow, acc: Set<Feature>): void => {
  for (const sl of d.slides) {
    addAttr(sl, acc);
    if (sl.notes !== undefined) {
      acc.add("deck.notes");
      walkBlocks(sl.notes, acc);
    }
    for (const sh of sl.shapes) walkShape(sh, acc);
  }
};

const walkBlocks = (ns: ReadonlyArray<Block>, acc: Set<Feature>): void => {
  for (const n of ns) walkBlock(n, acc);
};

const walkBlock = (b: Block, acc: Set<Feature>): void => {
  addTag(b._tag, acc);
  addAttr(b, acc);
  switch (b._tag) {
    case "Plain": case "Para": case "Header":
      walkInlines(b.content, acc);
      break;
    case "LineBlock":
      for (const line of b.lines) walkInlines(line, acc);
      break;
    case "CodeBlock": case "RawBlock": case "HorizontalRule":
      break;
    case "BlockQuote": case "Div":
      walkBlocks(b.content, acc);
      break;
    case "Figure":
      walkBlocks(b.caption, acc);
      walkBlocks(b.content, acc);
      break;
    case "OrderedList": case "BulletList":
      for (const item of b.items) walkBlocks(item, acc);
      break;
    case "DefinitionList":
      for (const item of b.items) {
        walkInlines(item.term, acc);
        for (const def of item.definitions) walkBlocks(def, acc);
      }
      break;
    case "Table":
      walkTable(b, acc);
      break;
    case "Worksheet":
      walkWorksheet(b, acc);
      break;
    case "SlideShow":
      walkSlideShow(b, acc);
      break;
  }
};

/** The set of features a document uses. */
export const collectFeatures = (doc: Document): Set<Feature> => {
  const acc = new Set<Feature>();
  let worksheetCount = 0;
  for (const b of doc.blocks) {
    if (b._tag === "Worksheet") worksheetCount += 1;
    walkBlock(b, acc);
  }
  if (worksheetCount > 1) acc.add("sheet.multiple");
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
