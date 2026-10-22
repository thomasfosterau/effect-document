/**
 * Character runs, shared by the WordprocessingML and DrawingML codecs: the
 * formatting a run carries, how a reader wraps a run's text in the document's
 * inline marks, how a writer walks those marks back into runs, and list
 * grouping while a body is read.
 */

import * as Arr from "effect/Array";
import * as Match from "effect/Match";
import * as Predicate from "effect/Predicate";
import {
  type Block,
  BulletList,
  Emph,
  type Inline,
  OrderedList,
  SmallCaps,
  Strikeout,
  Strong,
  Subscript,
  Superscript,
  Underline,
} from "@thomasfosterau/effect-document";

/** The character formatting a run carries (unset means off). */
export interface RunFormat {
  readonly b?: boolean | undefined;
  readonly i?: boolean | undefined;
  readonly u?: boolean | undefined;
  readonly strike?: boolean | undefined;
  readonly caps?: boolean | undefined;
  readonly vert?: "superscript" | "subscript" | undefined;
}

/** Wrap a run's text in the inline marks its formatting implies, innermost first. */
export const wrapRun = (node: Inline, f: RunFormat): Inline => {
  let x = node;
  if (f.caps) x = new SmallCaps({ content: [x] });
  if (f.vert === "superscript") x = new Superscript({ content: [x] });
  if (f.vert === "subscript") x = new Subscript({ content: [x] });
  if (f.i) x = new Emph({ content: [x] });
  if (f.b) x = new Strong({ content: [x] });
  if (f.u) x = new Underline({ content: [x] });
  if (f.strike) x = new Strikeout({ content: [x] });
  return x;
};

/** How a writer spells runs. */
export interface RunWriter {
  /** A run of text with the given formatting. */
  readonly text: (text: string, f: RunFormat) => string;
  /** A line break inside a paragraph. */
  readonly lineBreak: (f: RunFormat) => string;
  /** Any inline other than text, spaces, breaks and the four basic marks ("" to drop it). */
  readonly other: (n: Inline, f: RunFormat) => string;
}

/** Render inlines as runs, accumulating the formatting of the marks they sit inside. */
export const renderRuns = (ns: ReadonlyArray<Inline>, f: RunFormat, w: RunWriter): string =>
  ns.map((n) => renderRun(n, f, w)).join("");

const renderRun = (n: Inline, f: RunFormat, w: RunWriter): string =>
  Match.value(n).pipe(
    Match.tag("Str", (s) => w.text(s.text, f)),
    Match.tag("Space", "SoftBreak", () => w.text(" ", f)),
    Match.tag("LineBreak", () => w.lineBreak(f)),
    Match.tag("Emph", (m) => renderRuns(m.content, { ...f, i: true }, w)),
    Match.tag("Strong", (m) => renderRuns(m.content, { ...f, b: true }, w)),
    Match.tag("Underline", (m) => renderRuns(m.content, { ...f, u: true }, w)),
    Match.tag("Strikeout", (m) => renderRuns(m.content, { ...f, strike: true }, w)),
    Match.orElse((other) => w.other(other, f)),
  );

/** The inline content of a list item's paragraphs and headings, concatenated. */
export const itemInlines = (blocks: ReadonlyArray<Block>): Inline[] =>
  blocks.flatMap((b) =>
    Predicate.isTagged(b, "Para") ||
    Predicate.isTagged(b, "Plain") ||
    Predicate.isTagged(b, "Header")
      ? [...b.content]
      : [],
  );

/** A list paragraph's kind. */
export type ListKind = "bullet" | "ordered";

/**
 * Groups consecutive list paragraphs into `BulletList` / `OrderedList`
 * blocks appended to `out`: a change of kind, or `flush`, closes the list.
 */
export const makeListGrouper = (out: Block[]) => {
  let items: Block[][] = [];
  let kind: ListKind | undefined;
  const flush = (): void => {
    if (kind === undefined || Arr.isReadonlyArrayEmpty(items)) return;
    out.push(kind === "ordered" ? new OrderedList({ items }) : new BulletList({ items }));
    items = [];
    kind = undefined;
  };
  const add = (itemKind: ListKind, item: Block[]): void => {
    if (kind !== undefined && kind !== itemKind) flush();
    kind = itemKind;
    items.push(item);
  };
  return { add, flush };
};
