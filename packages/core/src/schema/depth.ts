/**
 * Nesting depth: how deeply blocks, inlines and shapes nest in a document.
 *
 * Every walk here uses an explicit stack, so measuring an arbitrarily deep
 * document can't overflow the call stack. Readers use {@link nestingDepth} to
 * refuse untrusted input that nests deeper than a limit, which keeps the rest
 * of the toolkit (including the recursive `narrow` and Schema encoding) within
 * safe bounds.
 */

import * as Match from "effect/Match";
import * as Predicate from "effect/Predicate";
import * as Arr from "effect/Array";
import type { Block, Inline, Shape } from "./ast.ts";
import type { Document } from "./document.ts";

/** A node that counts as one level of nesting. */
export type NestedNode = Block | Inline | Shape;

/**
 * The default maximum nesting depth readers accept: far above any real
 * document, far below what the recursive walks can handle.
 *
 * The binding constraint is Schema encoding: Effect's Schema parser recurses
 * several frames per schema level, and a `Table` level is three schema levels
 * (`Table`, `TableRow`, `Cell`). On Node's default stack, encoding a document
 * of nested tables overflows from about 240 levels in a fresh process, a
 * `DefinitionList` chain from about 290 and a `BlockQuote` chain from about
 * 630, so readers stop at 128.
 */
export const DEFAULT_MAX_NESTING_DEPTH = 128;

/** The blocks, inlines and shapes directly inside a node. */
export const nestedChildren = (n: NestedNode): ReadonlyArray<NestedNode> => {
  return Match.value(n).pipe(
    Match.tag(
      "Emph",
      "Strong",
      "Underline",
      "Strikeout",
      "Superscript",
      "Subscript",
      "SmallCaps",
      "Quoted",
      "Link",
      "Span",
      (n) => {
        return n.content;
      },
    ),
    Match.tag("Cite", (n) => {
      return [...n.content, ...n.citations.flatMap((c) => [...c.prefix, ...c.suffix])];
    }),
    Match.tag("Image", (n) => {
      return n.alt;
    }),
    Match.tag("Note", (n) => {
      return n.content;
      // ---- blocks
    }),
    Match.tag("Plain", "Para", "Header", (n) => {
      return n.content;
    }),
    Match.tag("LineBlock", (n) => {
      return n.lines.flat();
    }),
    Match.tag("BlockQuote", "Div", (n) => {
      return n.content;
    }),
    Match.tag("Figure", (n) => {
      return [...n.caption, ...n.content];
    }),
    Match.tag("OrderedList", "BulletList", (n) => {
      return n.items.flat();
    }),
    Match.tag("DefinitionList", (n) => {
      return n.items.flatMap((it) => [...it.term, ...it.definitions.flat()]);
    }),
    Match.tag("Table", (n) => {
      return [
        ...(n.caption ?? []),
        ...[...n.head, ...n.body, ...n.foot].flatMap((r) => r.cells.flatMap((c) => c.content)),
      ];
    }),
    Match.tag("Worksheet", (n) => {
      return n.rows.flatMap((r) =>
        r.cells.flatMap(({ cell: c }) => (Predicate.isTagged(c, "CellRichText") ? c.runs : [])),
      );
    }),
    Match.tag("SlideShow", (n) => {
      return n.slides.flatMap((s) => [...(s.notes ?? []), ...s.shapes]);
      // ---- shapes
    }),
    Match.tag("TextBox", "Placeholder", (n) => {
      return n.content;
    }),
    Match.tag("TableShape", (n) => {
      return [n.table];
    }),
    Match.orElse(() => {
      return [];
    }),
  );
};

/**
 * The deepest chain of nested blocks, inlines and shapes in `blocks`: 0 for
 * none, 1 for flat content, `n + 2` for a paragraph inside `n` block quotes.
 * Stops early once the depth exceeds `stopAbove`, if given.
 */
export const blocksNestingDepth = (
  blocks: ReadonlyArray<Block>,
  stopAbove = Number.POSITIVE_INFINITY,
): number => {
  let max = 0;
  const stack: Array<readonly [NestedNode, number]> = blocks.map((b) => [b, 1] as const);
  while (Arr.isReadonlyArrayNonEmpty(stack)) {
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
