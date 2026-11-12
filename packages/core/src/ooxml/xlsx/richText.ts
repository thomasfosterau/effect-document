/**
 * Rich shared strings (#66): an `<si>` of formatted runs (`<r><rPr>…</rPr><t>…</t></r>`)
 * read as a `CellRichText`, and a `CellRichText` written back as one. The marks
 * kept are the ones SpreadsheetML's run properties and the schema share: bold
 * (`b`), italic (`i`), underline (`u`), strikethrough (`strike`) and
 * superscript or subscript (`vertAlign`); font, size and colour are not read.
 */

import * as Arr from "effect/Array";
import * as Match from "effect/Match";
import {
  CellRichText,
  Emph,
  type Inline,
  softBreak,
  space,
  Strikeout,
  str,
  Strong,
  Subscript,
  Superscript,
  Underline,
} from "../../index.ts";
import { decodeXstring } from "./cellText.ts";
import { findChild, findChildren, type XmlElement } from "./xml.ts";

/** A run's marks: what its `<rPr>` sets that the schema has a mark for. */
interface Marks {
  readonly b: boolean;
  readonly i: boolean;
  readonly u: boolean;
  readonly strike: boolean;
  readonly vertAlign: "superscript" | "subscript" | undefined;
}

const NO_MARKS: Marks = { b: false, i: false, u: false, strike: false, vertAlign: undefined };

/** Whether a run has any mark. */
const isMarked = (m: Marks): boolean => m.b || m.i || m.u || m.strike || m.vertAlign !== undefined;

/** Whether two runs' marks are the same. */
const sameMarks = (a: Marks, b: Marks): boolean =>
  a.b === b.b && a.i === b.i && a.u === b.u && a.strike === b.strike && a.vertAlign === b.vertAlign;

/** A boolean run property (`<b/>`, `<i val="0"/>`): on unless its `val` says off. */
const toggle = (rPr: XmlElement, name: string): boolean => {
  const el = findChild(rPr, name);
  if (el === undefined) return false;
  const val = el.attrs["val"];
  return val !== "0" && val !== "false";
};

/** A run's marks, from its `<rPr>` (none without one). */
const marksOf = (r: XmlElement): Marks => {
  const rPr = findChild(r, "rPr");
  if (rPr === undefined) return NO_MARKS;
  const u = findChild(rPr, "u")?.attrs["val"];
  const vert = findChild(rPr, "vertAlign")?.attrs["val"];
  return {
    b: toggle(rPr, "b"),
    i: toggle(rPr, "i"),
    u: findChild(rPr, "u") !== undefined && u !== "none",
    strike: toggle(rPr, "strike"),
    vertAlign: vert === "superscript" || vert === "subscript" ? vert : undefined,
  };
};

/** A run's text: its `<t>`s, escapes decoded (a phonetic guide is not text). */
const textOf = (r: XmlElement): string =>
  decodeXstring(
    findChildren(r, "t")
      .map((t) => t.text)
      .join(""),
  );

/** Words and whitespace, a whitespace run with a line break in it being one break. */
const TOKENS = /(\s*\n\s*)|(\s+)|(\S+)/g;

/**
 * A run's text as inlines, keeping its edge whitespace (unlike `textInlines`,
 * which trims): `"Hello "` before a bold `"World"` keeps its space.
 */
export const inlinesOfText = (text: string): ReadonlyArray<Inline> =>
  Array.from(text.matchAll(TOKENS), ([, newline, , word]): Inline =>
    word !== undefined ? str(word) : newline !== undefined ? softBreak() : space(),
  );

/** `content` inside the marks `m` sets, innermost first: the reader's one canonical nesting. */
const wrap = (content: ReadonlyArray<Inline>, m: Marks): ReadonlyArray<Inline> => {
  const vert =
    m.vertAlign === "superscript"
      ? [new Superscript({ content })]
      : m.vertAlign === "subscript"
        ? [new Subscript({ content })]
        : content;
  const strike = m.strike ? [new Strikeout({ content: vert })] : vert;
  const under = m.u ? [new Underline({ content: strike })] : strike;
  const em = m.i ? [new Emph({ content: under })] : under;
  return m.b ? [new Strong({ content: em })] : em;
};

/**
 * A shared string from its `<si>`: its text (`<t>`, or runs none of which is
 * marked), or a `CellRichText` of its runs when any run carries a mark.
 */
export const sharedStringOf = (si: XmlElement): string | CellRichText => {
  const runs = findChildren(si, "r").map((r) => ({ text: textOf(r), marks: marksOf(r) }));
  if (!runs.some((r) => isMarked(r.marks))) {
    const plain = findChild(si, "t");
    return Arr.isReadonlyArrayNonEmpty(runs)
      ? runs.map((r) => r.text).join("")
      : decodeXstring(plain?.text ?? "");
  }
  return new CellRichText({
    runs: runs.flatMap((r) => wrap(inlinesOfText(r.text), r.marks)),
  });
};

/** A piece of a rich string's text under the marks around it. */
interface Piece {
  readonly text: string;
  readonly marks: Marks;
}

/** `inlines` as text pieces under their marks; anything without a run property reads as its text. */
const piecesOf = (inlines: ReadonlyArray<Inline>, marks: Marks): ReadonlyArray<Piece> =>
  inlines.flatMap((inline): ReadonlyArray<Piece> =>
    Match.value(inline).pipe(
      Match.tag("Str", (s) => [{ text: s.text, marks }]),
      Match.tag("Space", () => [{ text: " ", marks }]),
      Match.tag("SoftBreak", "LineBreak", () => [{ text: "\n", marks }]),
      Match.tag("Strong", (n) => piecesOf(n.content, { ...marks, b: true })),
      Match.tag("Emph", (n) => piecesOf(n.content, { ...marks, i: true })),
      Match.tag("Underline", (n) => piecesOf(n.content, { ...marks, u: true })),
      Match.tag("Strikeout", (n) => piecesOf(n.content, { ...marks, strike: true })),
      Match.tag("Superscript", (n) => piecesOf(n.content, { ...marks, vertAlign: "superscript" })),
      Match.tag("Subscript", (n) => piecesOf(n.content, { ...marks, vertAlign: "subscript" })),
      // a link's text is the cell's: the link itself is the worksheet's <hyperlinks> (#67)
      Match.tag("Link", (n) => piecesOf(n.content, marks)),
      // anything else is outside the XLSX profile, and narrow replaces it before a write
      Match.orElse(() => []),
    ),
  );

/** Adjacent pieces with the same marks as one. */
const merged = (pieces: ReadonlyArray<Piece>): ReadonlyArray<Piece> =>
  pieces.reduce<Array<Piece>>((acc, p) => {
    const last = acc.at(-1);
    if (last !== undefined && sameMarks(last.marks, p.marks))
      acc[acc.length - 1] = { text: last.text + p.text, marks: p.marks };
    else acc.push(p);
    return acc;
  }, []);

/** A run's `<rPr>`, or nothing for an unmarked run. */
const rPrXml = (m: Marks): string =>
  isMarked(m)
    ? `<rPr>${m.b ? "<b/>" : ""}${m.i ? "<i/>" : ""}${m.strike ? "<strike/>" : ""}${m.u ? "<u/>" : ""}${m.vertAlign === undefined ? "" : `<vertAlign val="${m.vertAlign}"/>`}</rPr>`
    : "";

/**
 * The runs of a rich shared string (an `<si>`'s content): one `<r>` per
 * stretch of text under the same marks, its text escaped with `escape` (the
 * writer's `escapeXstring`).
 */
export const richTextRunsXml = (
  runs: ReadonlyArray<Inline>,
  escape: (text: string) => string,
): string =>
  merged(piecesOf(runs, NO_MARKS))
    .map((p) => `<r>${rPrXml(p.marks)}<t xml:space="preserve">${escape(p.text)}</t></r>`)
    .join("");
