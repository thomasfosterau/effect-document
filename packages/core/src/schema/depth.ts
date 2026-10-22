/**
 * Nesting depth: how deeply blocks, inlines and shapes nest in a document.
 *
 * Every walk here uses an explicit stack, so measuring an arbitrarily deep
 * document can't overflow the call stack. Readers use {@link nestingDepth} to
 * refuse untrusted input that nests deeper than a limit, which keeps the rest
 * of the toolkit (including the recursive `narrow` and Schema encoding) within
 * safe bounds.
 */

import type { Block, Inline, Shape } from "./ast.js";
import type { Document } from "./document.js";

/** A node that counts as one level of nesting. */
export type NestedNode = Block | Inline | Shape;

/**
 * The default maximum nesting depth readers accept: far above any real
 * document, far below what the recursive walks can handle.
 */
export const DEFAULT_MAX_NESTING_DEPTH = 1000;

/** The blocks, inlines and shapes directly inside a node. */
export const nestedChildren = (n: NestedNode): ReadonlyArray<NestedNode> => {
  switch (n._tag) {
    // ---- inlines
    case "Emph": case "Strong": case "Underline": case "Strikeout":
    case "Superscript": case "Subscript": case "SmallCaps": case "Quoted":
    case "Link": case "Span":
      return n.content;
    case "Cite":
      return [...n.content, ...n.citations.flatMap((c) => [...c.prefix, ...c.suffix])];
    case "Image":
      return n.alt;
    case "Note":
      return n.content;
    // ---- blocks
    case "Plain": case "Para": case "Header":
      return n.content;
    case "LineBlock":
      return n.lines.flat();
    case "BlockQuote": case "Div":
      return n.content;
    case "Figure":
      return [...n.caption, ...n.content];
    case "OrderedList": case "BulletList":
      return n.items.flat();
    case "DefinitionList":
      return n.items.flatMap((it) => [...it.term, ...it.definitions.flat()]);
    case "Table":
      return [
        ...(n.caption ?? []),
        ...[...n.head, ...n.body, ...n.foot].flatMap((r) => r.cells.flatMap((c) => c.content)),
      ];
    case "Worksheet":
      return n.rows.flatMap((r) =>
        r.cells.flatMap((c) => (c._tag === "CellRichText" ? c.runs : []))
      );
    case "SlideShow":
      return n.slides.flatMap((s) => [...(s.notes ?? []), ...s.shapes]);
    // ---- shapes
    case "TextBox": case "Placeholder":
      return n.content;
    case "TableShape":
      return [n.table];
    default:
      return [];
  }
};

/**
 * The deepest chain of nested blocks, inlines and shapes in `blocks`: 0 for
 * none, 1 for flat content, `n + 2` for a paragraph inside `n` block quotes.
 * Stops early once the depth exceeds `stopAbove`, if given.
 */
export const blocksNestingDepth = (
  blocks: ReadonlyArray<Block>,
  stopAbove = Number.POSITIVE_INFINITY
): number => {
  let max = 0;
  const stack: Array<readonly [NestedNode, number]> = blocks.map((b) => [b, 1] as const);
  while (stack.length > 0) {
    const [node, depth] = stack.pop()!;
    if (depth > max) {
      max = depth;
      if (max > stopAbove) return max;
    }
    for (const child of nestedChildren(node)) stack.push([child, depth + 1]);
  }
  return max;
};

/** The nesting depth of a document's blocks; see {@link blocksNestingDepth}. */
export const nestingDepth = (doc: Document, stopAbove?: number): number =>
  blocksNestingDepth(doc.blocks, stopAbove);
