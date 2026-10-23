/**
 * A normal form for comparing a document with its round trip through a
 * format (#109). Two documents with the same normal form say the same thing;
 * the normalisations are the representational choices the schema leaves open
 * and no format can be expected to keep:
 *
 * - inline content becomes a run of words and spaces: `Space` and `SoftBreak`
 *   are one space, whitespace carries no marks, nested or reordered marks are
 *   a set (superscript inside subscript, or the reverse, is the innermost),
 *   adjacent words with the same marks merge, whitespace at the edge of
 *   inline code is a space beside it, code spans separated by a space are one
 *   span, and block edges are trimmed;
 * - `Plain` reads as `Para` (no writer here distinguishes a tight paragraph);
 * - a table's head, body and foot are one list of rows;
 * - a worksheet loses trailing blank cells and rows (a sparse grid has no
 *   extent beyond its last value);
 * - document metadata is ignored (the readers add their own).
 *
 * Anything else that differs is a loss: the format's write profile claims a
 * feature its writer and reader don't preserve. The traversals at the end
 * rewrite a normal form, for the per-format limits in
 * `integration/profile-property.test.ts`.
 */

import * as Arr from "effect/Array";
import * as Match from "effect/Match";
import * as Order from "effect/Order";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import type { Block, Document, Inline, SheetCell, Shape } from "@thomasfosterau/effect-document";

// ============================================================================
// The normal form
// ============================================================================

/** A normalised inline token: a word with its marks, a space, a line break or inline code. */
export type Token =
  | { readonly _tag: "Word"; readonly text: string; readonly marks: string }
  | { readonly _tag: "Space" }
  | { readonly _tag: "Break" }
  | { readonly _tag: "Code"; readonly text: string; readonly marks: string };

/** A normalised spreadsheet cell: its kind and value as text. */
export interface NormalCell {
  readonly _tag: string;
  readonly value: string;
}

/** A normalised slide shape. */
export interface NormalShape {
  readonly _tag: string;
  readonly placeholder: string;
  readonly content: ReadonlyArray<NormalBlock>;
}

/** A normalised block. */
export type NormalBlock =
  | { readonly _tag: "Para"; readonly text: ReadonlyArray<Token> }
  | { readonly _tag: "Header"; readonly level: number; readonly text: ReadonlyArray<Token> }
  | { readonly _tag: "Code"; readonly text: string }
  | { readonly _tag: "Rule" }
  | { readonly _tag: "Lines"; readonly lines: ReadonlyArray<ReadonlyArray<Token>> }
  | { readonly _tag: "Quote" | "Div"; readonly content: ReadonlyArray<NormalBlock> }
  | {
      readonly _tag: "Bullets" | "Ordered";
      readonly items: ReadonlyArray<ReadonlyArray<NormalBlock>>;
    }
  | {
      readonly _tag: "Table";
      readonly rows: ReadonlyArray<ReadonlyArray<ReadonlyArray<NormalBlock>>>;
    }
  | {
      readonly _tag: "Sheet";
      readonly name: string;
      readonly rows: ReadonlyArray<ReadonlyArray<NormalCell>>;
    }
  | { readonly _tag: "Slides"; readonly slides: ReadonlyArray<ReadonlyArray<NormalShape>> }
  | { readonly _tag: "Other"; readonly node: string };

/** A document's normal form. */
export type Normal = ReadonlyArray<NormalBlock>;

// ============================================================================
// Normalising
// ============================================================================

/** `xs` without its trailing items that satisfy `p`. */
const dropRightWhile = <A>(xs: ReadonlyArray<A>, p: (a: A) => boolean): Array<A> =>
  Arr.reverse(Arr.dropWhile(Arr.reverse(xs), p));

const VERTICAL: ReadonlySet<string> = new Set(["Superscript", "Subscript"]);

/** The marks in effect inside `mark`, as a canonical string (sorted, deduplicated). */
const withMark = (marks: string, mark: string): string =>
  Arr.sort(
    Arr.dedupe([
      // a run is raised or lowered, not both: the innermost wins
      ...marks.split("|").filter((m) => m !== "" && !(VERTICAL.has(m) && VERTICAL.has(mark))),
      mark,
    ]),
    Order.String,
  ).join("|");

const SPACE: Token = { _tag: "Space" };

const wordsOf = (text: string, marks: string): ReadonlyArray<Token> =>
  text
    .split(/(\s+)/)
    .flatMap((part): ReadonlyArray<Token> =>
      Str.isEmpty(part) ? [] : /^\s+$/.test(part) ? [SPACE] : [{ _tag: "Word", text: part, marks }],
    );

/** Inline code as a token; whitespace at its edges is a space beside it. */
const codeOf = (text: string, marks: string): ReadonlyArray<Token> => [
  ...(/^\s/.test(text) ? [SPACE] : []),
  ...(Str.isEmpty(text.trim()) ? [] : [{ _tag: "Code", text: text.trim(), marks } as const]),
  ...(/\s$/.test(text) ? [SPACE] : []),
];

const tokensOf = (inlines: ReadonlyArray<Inline>, marks: string): ReadonlyArray<Token> =>
  inlines.flatMap((inline): ReadonlyArray<Token> =>
    Match.value(inline).pipe(
      Match.tag("Str", ({ text }) => wordsOf(text, marks)),
      Match.tag("Space", "SoftBreak", (): ReadonlyArray<Token> => [SPACE]),
      Match.tag("LineBreak", (): ReadonlyArray<Token> => [{ _tag: "Break" }]),
      Match.tag("Code", ({ text }) => codeOf(text, marks)),
      Match.tag("Link", ({ content, target }) =>
        tokensOf(content, withMark(marks, `link:${target.url}`)),
      ),
      Match.tag("Quoted", ({ content, quoteType }) =>
        tokensOf(content, withMark(marks, `quoted:${quoteType}`)),
      ),
      Match.tag(
        "Emph",
        "Strong",
        "Underline",
        "Strikeout",
        "Superscript",
        "Subscript",
        "SmallCaps",
        "Span",
        (node) => tokensOf(node.content, withMark(marks, node._tag)),
      ),
      Match.orElse((node): ReadonlyArray<Token> => [
        { _tag: "Word", text: `<${node._tag}>`, marks },
      ]),
    ),
  );

const isSpace = Predicate.isTagged("Space");
const isBreak = Predicate.isTagged("Break");
const isWord = Predicate.isTagged("Word");
const isCode = Predicate.isTagged("Code");

/** Append `token`: spaces collapse (and give way to line breaks), same-marked words merge. */
const pushToken = (out: Array<Token>, token: Token): Array<Token> => {
  const prev = out.at(-1);
  if (isSpace(token)) {
    // a space at the start, after a space or before a line break is layout
    if (prev !== undefined && !isSpace(prev) && !isBreak(prev)) out.push(token);
  } else if (isBreak(token) && prev !== undefined && isSpace(prev)) {
    out[out.length - 1] = token;
  } else if (isWord(token) && prev !== undefined && isWord(prev) && prev.marks === token.marks) {
    out[out.length - 1] = { ...prev, text: prev.text + token.text };
  } else out.push(token);
  return out;
};

/** Inline code, a space and inline code with the same marks: one code span. */
const pushCode = (merged: Array<Token>, token: Token): Array<Token> => {
  const [a, b] = [merged.at(-2), merged.at(-1)];
  if (
    isCode(token) &&
    b !== undefined &&
    isSpace(b) &&
    a !== undefined &&
    isCode(a) &&
    a.marks === token.marks
  ) {
    merged.splice(-2, 2, { ...a, text: `${a.text} ${token.text}` });
  } else merged.push(token);
  return merged;
};

/** Tokens in normal form: rebuilt with {@link pushToken}, trimmed, code spans merged. */
export const normalizeTokens = (tokens: ReadonlyArray<Token>): ReadonlyArray<Token> =>
  dropRightWhile(tokens.reduce<Array<Token>>(pushToken, []), isSpace).reduce<Array<Token>>(
    pushCode,
    [],
  );

/** Inline content in normal form. */
export const normalizeInlines = (inlines: ReadonlyArray<Inline>): ReadonlyArray<Token> =>
  normalizeTokens(tokensOf(inlines, ""));

/** A block in normal form. */
export const normalizeBlock = (block: Block): NormalBlock =>
  Match.value(block).pipe(
    Match.tag("Para", "Plain", ({ content }): NormalBlock => ({
      _tag: "Para",
      text: normalizeInlines(content),
    })),
    Match.tag("Header", ({ level, content }): NormalBlock => ({
      _tag: "Header",
      level,
      text: normalizeInlines(content),
    })),
    Match.tag("CodeBlock", ({ text }): NormalBlock => ({
      _tag: "Code",
      text: text.replace(/\n+$/, ""),
    })),
    Match.tag("HorizontalRule", (): NormalBlock => ({ _tag: "Rule" })),
    Match.tag("LineBlock", ({ lines }): NormalBlock => ({
      _tag: "Lines",
      lines: lines.map(normalizeInlines),
    })),
    Match.tag("BlockQuote", ({ content }): NormalBlock => ({
      _tag: "Quote",
      content: normalizeBlocks(content),
    })),
    Match.tag("Div", ({ content }): NormalBlock => ({
      _tag: "Div",
      content: normalizeBlocks(content),
    })),
    Match.tag("BulletList", ({ items }): NormalBlock => ({
      _tag: "Bullets",
      items: items.map(normalizeBlocks),
    })),
    Match.tag("OrderedList", ({ items }): NormalBlock => ({
      _tag: "Ordered",
      items: items.map(normalizeBlocks),
    })),
    Match.tag("Table", ({ head, body, foot }): NormalBlock => ({
      _tag: "Table",
      rows: [...head, ...body, ...foot].map((row) =>
        row.cells.map((cell) => normalizeBlocks(cell.content)),
      ),
    })),
    Match.tag("Worksheet", ({ name, rows }): NormalBlock => ({
      _tag: "Sheet",
      name,
      rows: normalizeGrid(rows),
    })),
    Match.tag("SlideShow", ({ slides }): NormalBlock => ({
      _tag: "Slides",
      slides: slides.map((slide) => slide.shapes.map(normalizeShape)),
    })),
    Match.orElse((node): NormalBlock => ({ _tag: "Other", node: node._tag })),
  );

/** Blocks in normal form. */
export const normalizeBlocks = (blocks: ReadonlyArray<Block>): Normal => blocks.map(normalizeBlock);

const normalizeShape = (shape: Shape): NormalShape =>
  Match.value(shape).pipe(
    Match.tag("TextBox", ({ content }) => ({
      _tag: "TextBox",
      placeholder: "",
      content: normalizeBlocks(content),
    })),
    Match.tag("Placeholder", ({ placeholderType, content }) => ({
      _tag: "Placeholder",
      placeholder: placeholderType,
      content: normalizeBlocks(content),
    })),
    Match.orElse((node) => ({ _tag: node._tag, placeholder: "", content: [] })),
  );

const normalizeCell = (cell: SheetCell): NormalCell =>
  Match.value(cell).pipe(
    Match.tag("CellText", "CellError", ({ _tag, value }) => ({ _tag, value })),
    Match.tag("CellNumber", ({ value }) => ({ _tag: "CellNumber", value: String(value) })),
    Match.tag("CellBoolean", ({ value }) => ({ _tag: "CellBoolean", value: String(value) })),
    Match.tag("CellBlank", () => ({ _tag: "CellBlank", value: "" })),
    Match.tag("CellFormula", ({ formula, result }) => ({
      _tag: "CellFormula",
      value: `${formula} = ${result ?? ""}`,
    })),
    Match.tag("CellDate", ({ value }) => ({ _tag: "CellDate", value: value.toISOString() })),
    Match.orElse((node) => ({ _tag: node._tag, value: "" })),
  );

const normalizeGrid = (
  rows: ReadonlyArray<{ readonly cells: ReadonlyArray<SheetCell> }>,
): ReadonlyArray<ReadonlyArray<NormalCell>> =>
  dropRightWhile(
    rows.map((row) =>
      dropRightWhile(row.cells, Predicate.isTagged("CellBlank")).map(normalizeCell),
    ),
    Arr.isReadonlyArrayEmpty,
  );

/** A document in normal form (its blocks; metadata is ignored). */
export const normalize = (doc: Document): Normal => normalizeBlocks(doc.blocks);

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/** A normal form as JSON, to compare and to print. */
export const normalJson = (normal: Normal): string => encodeJson(normal);

// ============================================================================
// Rewriting a normal form
// ============================================================================

/** Rewrite every list of blocks in a normal form, innermost first. */
export const mapBlockLists = (normal: Normal, f: (blocks: Normal) => Normal): Normal => {
  const list = (blocks: Normal): Normal => f(blocks.map(block));
  const block = (b: NormalBlock): NormalBlock =>
    Match.value(b).pipe(
      Match.tag("Quote", "Div", (q): NormalBlock => ({ ...q, content: list(q.content) })),
      Match.tag("Bullets", "Ordered", (l): NormalBlock => ({ ...l, items: l.items.map(list) })),
      Match.tag("Table", (t): NormalBlock => ({ ...t, rows: t.rows.map((r) => r.map(list)) })),
      Match.tag("Slides", (s): NormalBlock => ({
        ...s,
        slides: s.slides.map((shapes) =>
          shapes.map((shape) => ({ ...shape, content: list(shape.content) })),
        ),
      })),
      Match.orElse((other) => other),
    );
  return list(normal);
};

/** Rewrite every block in a normal form. */
export const mapBlocks = (normal: Normal, f: (block: NormalBlock) => NormalBlock): Normal =>
  mapBlockLists(normal, (blocks) => blocks.map(f));

/** Rewrite every run of inline tokens in a normal form. */
export const mapTokens = (
  normal: Normal,
  f: (tokens: ReadonlyArray<Token>) => ReadonlyArray<Token>,
): Normal =>
  mapBlocks(normal, (b) =>
    Match.value(b).pipe(
      Match.tag("Para", "Header", (p): NormalBlock => ({ ...p, text: f(p.text) })),
      Match.tag("Lines", (l): NormalBlock => ({ ...l, lines: l.lines.map(f) })),
      Match.orElse((other) => other),
    ),
  );
