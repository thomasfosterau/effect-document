import * as Str from "effect/String";
/**
 * The PDF Writer: a PDF-profile document -> .pdf bytes.
 *
 * A small typesetter lays the blocks out top to bottom on fixed-size pages:
 * paragraphs are word-wrapped using the standard fonts' metrics, headings are
 * set larger and bold, lists are indented under bullets or numbers (nested
 * lists indent further), code is set in Courier with its line breaks kept,
 * block quotes are indented, and rules are drawn. Bold/italic runs switch to
 * the matching Helvetica face, inline code to Courier; underline and
 * strikeout are drawn as lines; links get a URI link annotation.
 *
 * Text uses the standard 14 fonts with WinAnsiEncoding, so nothing is
 * embedded and the output is small - but only characters WinAnsiEncoding can
 * represent (Latin-1 plus a few typographic marks) render; anything else is
 * written as `?`. The document's `title`/`author`/`subject`/`keywords`
 * metadata go into the document information dictionary.
 */

import * as Schema from "effect/Schema";
import * as Order from "effect/Order";
import { describeCause } from "./describe.ts";
import * as Predicate from "effect/Predicate";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Match from "effect/Match";
import {
  type Block,
  type BlockOf,
  bytes,
  type Content,
  type Doc,
  type Inline,
  type InlineOf,
  inlinesToText,
  isNodeIn,
  makeWriterTag,
  WriteError,
  type Writer,
  type Meta,
  type BulletList,
  type CodeBlock,
  type OrderedList,
} from "@thomasfosterau/effect-document";
import {
  type PdfDict,
  type PdfObject,
  type PdfRef,
  latin1ToBytes,
  pdfArray,
  pdfDict,
  pdfName,
  pdfStream,
  pdfTextString,
} from "./cos/objects.ts";
import { PdfBuilder, fileId, flateStream } from "./cos/serialize.ts";
import { type StandardFont, baseEncoding, standardWidths, winAnsiCode } from "./text/encodings.ts";
import { Pdf, type PdfFeature } from "./profile.ts";

/** Page sizes in points. */
export const PAGE_SIZES = {
  a4: [595.28, 841.89],
  letter: [612, 792],
  legal: [612, 1008],
  a5: [419.53, 595.28],
} as const;

/** Options for the PDF writer. */
export interface PdfWriterOptions {
  /** Page size: a named size or `[width, height]` in points (default `a4`). */
  readonly pageSize?: keyof typeof PAGE_SIZES | readonly [number, number] | undefined;
  /** Page margin in points (default 72, one inch). */
  readonly margin?: number | undefined;
  /** Body font size in points (default 11). */
  readonly fontSize?: number | undefined;
  /** Flate-compress page content (default true). */
  readonly compress?: boolean | undefined;
}

// ============================================================================
// Fonts and measuring
// ============================================================================

interface Style {
  readonly bold: boolean;
  readonly italic: boolean;
  readonly mono: boolean;
  readonly underline: boolean;
  readonly strike: boolean;
  readonly url: string | undefined;
}

const PLAIN: Style = {
  bold: false,
  italic: false,
  mono: false,
  underline: false,
  strike: false,
  url: undefined,
};

const fontOf = (s: Pick<Style, "bold" | "italic" | "mono">): StandardFont => {
  const family = s.mono ? "Courier" : "Helvetica";
  if (s.bold && s.italic) return `${family}-BoldOblique`;
  if (s.bold) return `${family}-Bold`;
  if (s.italic) return `${family}-Oblique`;
  return family;
};

const winAnsiNames = baseEncoding("WinAnsiEncoding");

/** WinAnsi bytes for text; unrepresentable characters become `?`. */
const encode = (text: string): number[] => {
  const out: number[] = [];
  for (const ch of text) out.push(winAnsiCode(ch) ?? 0x3f);
  return out;
};

const widthCache = new Map<StandardFont, (glyph: string) => number | undefined>();

/** The width of text in points. */
const measure = (text: string, font: StandardFont, size: number): number => {
  let w = widthCache.get(font);
  if (w === undefined) {
    w = standardWidths(font);
    widthCache.set(font, w);
  }
  let total = 0;
  for (const code of encode(text)) total += w(winAnsiNames[code] ?? "") ?? 556;
  return (total * size) / 1000;
};

// ============================================================================
// Inline flattening and line breaking
// ============================================================================

interface Piece {
  readonly text: string;
  readonly style: Style;
}

/** Styled text pieces; `null` marks a hard line break. */
type Pieces = Array<Piece | null>;

/** Flatten inlines into styled text pieces. */
const flatten = (inlines: ReadonlyArray<Inline>, style: Style, out: Pieces = []): Pieces => {
  // inlines outside the PDF profile (narrowing removes them first) are dropped
  for (const n of inlines) if (isNodeIn(Pdf, n)) flattenInline(n, style, out);
  return out;
};

/**
 * Flatten one inline of the PDF profile. The table is exhaustive over the
 * profile's inlines, so a feature added to it without a rendering here is a
 * compile error (#109).
 */
const flattenInline = (n: InlineOf<PdfFeature>, style: Style, out: Pieces): void =>
  Match.valueTags(n, {
    Str: (s) => void out.push({ text: s.text, style }),
    Space: () => void out.push({ text: " ", style }),
    SoftBreak: () => void out.push({ text: " ", style }),
    LineBreak: () => void out.push(null),
    Emph: (m) => void flatten(m.content, { ...style, italic: true }, out),
    Strong: (m) => void flatten(m.content, { ...style, bold: true }, out),
    Underline: (m) => void flatten(m.content, { ...style, underline: true }, out),
    Strikeout: (m) => void flatten(m.content, { ...style, strike: true }, out),
    Code: (c) => void out.push({ text: c.text, style: { ...style, mono: true } }),
    Link: (l) => void flatten(l.content, { ...style, url: l.target.url }, out),
  });

/** A positioned run of text on a line. */
interface Segment {
  readonly text: string;
  readonly style: Style;
  readonly x: number;
  readonly width: number;
}

interface LaidLine {
  readonly segments: ReadonlyArray<Segment>;
  readonly width: number;
}

/** Break styled pieces into lines no wider than `maxWidth`. */
const breakLines = (
  pieces: ReadonlyArray<Piece | null>,
  size: number,
  maxWidth: number,
): LaidLine[] => {
  // tokens: words and spaces, each in one style
  type Tok = { text: string; style: Style; space: boolean } | null;
  const toks: Tok[] = [];
  for (const p of pieces) {
    if (p === null) {
      toks.push(null);
      continue;
    }
    for (const part of p.text.replace(/[\r\n\t]+/g, " ").split(/( +)/)) {
      if (part !== "") toks.push({ text: part, style: p.style, space: part.startsWith(" ") });
    }
  }

  const lines: LaidLine[] = [];
  let segs: Segment[] = [];
  let x = 0;
  const push = (text: string, style: Style): void => {
    const width = measure(text, fontOf(style), size);
    const last = segs[segs.length - 1];
    if (last !== undefined && last.style === style)
      segs[segs.length - 1] = { ...last, text: last.text + text, width: last.width + width };
    else segs.push({ text, style, x, width });
    x += width;
  };
  const flush = (): void => {
    // trailing spaces don't count
    while (Arr.isReadonlyArrayNonEmpty(segs) && segs[segs.length - 1]!.text.trim() === "")
      x -= segs.pop()!.width;
    const last = segs[segs.length - 1];
    if (last !== undefined && /\s$/.test(last.text)) {
      const text = last.text.replace(/\s+$/, "");
      const width = measure(text, fontOf(last.style), size);
      x -= last.width - width;
      segs[segs.length - 1] = { ...last, text, width };
    }
    lines.push({ segments: segs, width: x });
    segs = [];
    x = 0;
  };

  for (let i = 0; i < toks.length; i++) {
    // SAFETY: `i < toks.length`, so the element exists
    const t = toks[i] as Tok;
    if (t === null) {
      flush();
      continue;
    }
    if (t.space) {
      if (Arr.isReadonlyArrayNonEmpty(segs)) push(" ", t.style);
      continue;
    }
    // a word together with any directly attached words in other styles
    let wordWidth = 0;
    let j = i;
    while (j < toks.length && toks[j] !== null && !toks[j]!.space) {
      wordWidth += measure(toks[j]!.text, fontOf(toks[j]!.style), size);
      j++;
    }
    if (x + wordWidth > maxWidth && segs.some((s) => s.text.trim() !== "")) flush();
    for (let k = i; k < j; k++) {
      const w = toks[k]!;
      // a word longer than the line is broken by characters
      let rest = w.text;
      while (x + measure(rest, fontOf(w.style), size) > maxWidth && rest.length > 1) {
        let n = rest.length - 1;
        while (n > 1 && x + measure(rest.slice(0, n), fontOf(w.style), size) > maxWidth) n--;
        if (x > 0 && n <= 1) {
          flush();
          continue;
        }
        push(rest.slice(0, n), w.style);
        flush();
        rest = rest.slice(n);
      }
      push(rest, w.style);
    }
    i = j - 1;
  }
  if (Arr.isReadonlyArrayNonEmpty(segs) || Arr.isReadonlyArrayEmpty(lines)) flush();
  return lines;
};

// ============================================================================
// Pages
// ============================================================================

// ============================================================================
// Structure (tagged PDF, #198)
// ============================================================================

/**
 * A structure element being built: its standard structure type (`P`, `H2`,
 * `L`, …), its attributes (`/A`) and its kids in reading order. The writer
 * tags its output (#198) so a reader can take the structure from the tags
 * rather than infer it from the layout.
 */
interface StructNode {
  /** The element's number, in the order elements were opened (the root is 0). */
  readonly id: number;
  readonly type: string;
  readonly attributes: PdfDict | undefined;
  readonly kids: Array<StructKid>;
}

/** A structure element's kid: another element, a marked-content sequence on a page, or a link annotation. */
type StructKid =
  | { readonly _tag: "Node"; readonly node: StructNode }
  | { readonly _tag: "Content"; readonly page: number; readonly mcid: number }
  | { readonly _tag: "Annot"; readonly page: number; readonly link: number };

interface PageOut {
  /** The page's index, which is also its `/StructParents` key. */
  readonly index: number;
  readonly ops: string[];
  readonly links: Array<{
    rect: [number, number, number, number];
    url: string;
    /** The `Link` structure element the annotation belongs to. */
    owner: StructNode;
  }>;
  /** The structure element each marked-content id on the page belongs to, by id. */
  readonly mcids: Array<StructNode>;
}

const num = (n: number): string => {
  const s = n.toFixed(2).replace(/\.?0+$/, "");
  return s === "-0" ? "0" : s;
};

const pdfText = (text: string): string => {
  let out = "(";
  for (const b of encode(text)) {
    if (b === 0x28 || b === 0x29 || b === 0x5c) out += "\\" + String.fromCharCode(b);
    else if (b < 0x20 || b > 0x7e) out += "\\" + b.toString(8).padStart(3, "0");
    else out += String.fromCharCode(b);
  }
  return out + ")";
};

const HEADING_SIZES = [24, 20, 17, 15, 13.5, 12.5];

/** Where the typesetter is: the current page and the baseline on it. */
interface Position {
  readonly page: PageOut;
  readonly y: number;
}

/** Where a block starts: its page's index and the top of its first line. */
interface Anchor {
  readonly page: number;
  readonly top: number;
}

/** A heading, for the document outline (#20): its level, its text and where it starts. */
interface OutlineEntry {
  readonly level: number;
  readonly title: string;
  readonly at: Anchor;
}

class Typesetter {
  readonly pages: PageOut[] = [];
  /** The headings, in order, for the outline. */
  readonly headings: OutlineEntry[] = [];
  readonly fonts = new Set<StandardFont>();
  /** The structure tree's root element. */
  readonly root: StructNode = { id: 0, type: "Document", attributes: undefined, kids: [] };
  /** How many structure elements there are, the root included. */
  elements = 1;
  /** The open structure elements, outermost first. */
  private readonly open: Array<StructNode> = [this.root];
  /** The marked-content sequence open on the page, and the element it belongs to. */
  private marked: StructNode | undefined;
  private page!: PageOut;
  private y = 0;
  private readonly top: number;
  private readonly bottom: number;

  readonly width: number;
  readonly height: number;
  readonly margin: number;
  readonly body: number;

  constructor(width: number, height: number, margin: number, body: number) {
    this.width = width;
    this.height = height;
    this.margin = margin;
    this.body = body;
    this.top = height - margin;
    this.bottom = margin;
    this.newPage();
  }

  private newPage(): void {
    this.endMarked();
    this.page = { index: this.pages.length, ops: [], links: [], mcids: [] };
    this.pages.push(this.page);
    this.y = this.top;
  }

  private get current(): StructNode {
    // the root is never popped
    return this.open[this.open.length - 1] ?? this.root;
  }

  /** Open a structure element inside the current one; its content follows until {@link end}. */
  begin(type: string, attributes?: PdfDict): void {
    this.endMarked();
    const node: StructNode = { id: this.elements++, type, attributes, kids: [] };
    this.current.kids.push({ _tag: "Node", node });
    this.open.push(node);
  }

  /** Close the innermost structure element. */
  end(): void {
    this.endMarked();
    if (this.open.length > 1) this.open.pop();
  }

  /** Make sure the content that follows is marked as the current element's, on this page. */
  private beginMarked(): void {
    const owner = this.current;
    if (this.marked === owner) return;
    this.endMarked();
    const mcid = this.page.mcids.length;
    this.page.mcids.push(owner);
    owner.kids.push({ _tag: "Content", page: this.page.index, mcid });
    this.page.ops.push(`/${owner.type} <</MCID ${mcid}>> BDC`);
    this.marked = owner;
  }

  /** End the open marked-content sequence, if any (at a page or element boundary). */
  endMarked(): void {
    if (this.marked === undefined) return;
    this.page.ops.push("EMC");
    this.marked = undefined;
  }

  /** Drawing that is decoration, not content (a rule, an underline, a quote bar): an artifact. */
  private artifact(op: string): void {
    this.endMarked();
    this.page.ops.push("/Artifact BMC", op, "EMC");
  }

  /** Leave vertical space (not at the top of a page). */
  space(amount: number): void {
    if (this.y < this.top) this.y -= amount;
  }

  /** Make sure `amount` fits on the page, or start a new one. */
  private need(amount: number): void {
    if (this.y - amount < this.bottom && this.y < this.top) this.newPage();
  }

  /**
   * Set laid-out lines at a left offset, with a line height. A list item's
   * `marker` is set beside the first line as its `Lbl` element, after which
   * the elements `marker.body` names are opened (the item's `LBody`, and the
   * paragraph inside it) for the lines to belong to.
   */
  lines(
    lines: ReadonlyArray<LaidLine>,
    left: number,
    size: number,
    lineHeight: number,
    marker?: { text: string; x: number; body: ReadonlyArray<string> },
  ): Anchor {
    const ascent = size * 0.75;
    let anchor: Anchor = { page: this.page.index, top: this.y };
    lines.forEach((line, i) => {
      this.need(lineHeight);
      if (i === 0) anchor = { page: this.page.index, top: this.y };
      const baseline = this.y - ascent - (lineHeight - size) / 2;
      if (i === 0 && marker !== undefined) {
        this.begin("Lbl");
        this.text(marker.text, PLAIN, size, this.margin + marker.x, baseline);
        this.end();
        marker.body.forEach((type) => this.begin(type));
      }
      for (const seg of line.segments) {
        const link = seg.style.url !== undefined;
        if (link) this.begin("Link");
        this.text(seg.text, seg.style, size, this.margin + left + seg.x, baseline, seg.width);
        if (link) this.end();
      }
      this.y -= lineHeight;
    });
    return anchor;
  }

  private text(
    text: string,
    style: Style,
    size: number,
    x: number,
    y: number,
    width?: number,
  ): void {
    if (text === "") return;
    const font = fontOf(style);
    this.fonts.add(font);
    this.beginMarked();
    const ops = this.page.ops;
    if (style.url !== undefined) ops.push("0 0 0.6 rg");
    ops.push(`BT /${fontKey(font)} ${num(size)} Tf ${num(x)} ${num(y)} Td ${pdfText(text)} Tj ET`);
    if (style.url !== undefined) ops.push("0 g");
    const w = width ?? measure(text, font, size);
    if (style.url !== undefined) {
      const owner = this.current;
      owner.kids.push({ _tag: "Annot", page: this.page.index, link: this.page.links.length });
      this.page.links.push({
        rect: [x, y - size * 0.22, x + w, y + size * 0.8],
        url: style.url,
        owner,
      });
    }
    const rule = (dy: number): void => {
      this.artifact(
        `${num(size / 18)} w ${num(x)} ${num(y + dy)} m ${num(x + w)} ${num(y + dy)} l S`,
      );
    };
    if (style.underline) rule(-size * 0.12);
    if (style.strike) rule(size * 0.3);
  }

  /** A horizontal rule across the text width. */
  rule(left: number): void {
    this.need(this.body);
    const y = this.y - this.body / 2;
    this.artifact(
      `0.5 w ${num(this.margin + left)} ${num(y)} m ${num(this.width - this.margin)} ${num(y)} l S`,
    );
    this.y -= this.body;
  }

  /** A vertical bar beside a block quote, from `fromY` to the current position. */
  bar(x: number, fromY: number, toY: number): void {
    this.artifact(`0.6 g ${num(this.margin + x)} ${num(toY)} 2 ${num(fromY - toY)} re f 0 g`);
  }

  get position(): Position {
    return { page: this.page, y: this.y };
  }
}

const fontKey = (font: StandardFont): string => "F" + font.replace(/[^A-Za-z]/g, "");

/** A code block: monospaced, hard-wrapped at the column limit, line breaks and indentation kept. */
const layoutCodeBlock = (ts: Typesetter, b: CodeBlock, left: number, textWidth: number): void => {
  const body = ts.body;
  const size = body * 0.85;
  const charWidth = size * 0.6;
  const perLine = Math.max(8, Math.floor(textWidth / charWidth));
  const out: LaidLine[] = [];
  for (const raw of b.text.replace(/\t/g, "    ").split(/\r?\n/)) {
    for (let start = 0; start === 0 || start < raw.length; start += perLine) {
      const chunk = raw.slice(start, start + perLine);
      // leading spaces become an offset, so the text starts where its ink does
      const indent = chunk.length - chunk.trimStart().length;
      const text = chunk.trimStart();
      out.push({
        segments:
          text === ""
            ? []
            : [
                {
                  text,
                  style: { ...PLAIN, mono: true },
                  x: indent * charWidth,
                  width: text.length * charWidth,
                },
              ],
        width: chunk.length * charWidth,
      });
      if (Str.isEmpty(raw)) break;
    }
  }
  // block-level code: a `Code` element placed as a block
  ts.begin("Code", pdfDict({ O: pdfName("Layout"), Placement: pdfName("Block") }));
  ts.lines(out, left, size, size * 1.3);
  ts.end();
  ts.space(body * 0.8);
};

/** A bullet or ordered list: each item's first paragraph beside its marker, the rest indented. */
const layoutList = (
  ts: Typesetter,
  b: BulletList | OrderedList,
  left: number,
  textWidth: number,
  tight: boolean,
): void => {
  const body = ts.body;
  const indent = 18;
  const ordered = Predicate.isTagged(b, "OrderedList");
  // `L` > `LI` > `Lbl` (the marker) and `LBody` (the item's blocks)
  ts.begin(
    "L",
    pdfDict({ O: pdfName("List"), ListNumbering: pdfName(ordered ? "Decimal" : "Disc") }),
  );
  b.items.forEach((item, k) => {
    const marker = ordered ? `${(b.start ?? 1) + k}.` : "•";
    ts.begin("LI");
    item.forEach((child, c) => {
      if (c === 0 && (Predicate.isTagged(child, "Plain") || Predicate.isTagged(child, "Para"))) {
        const lines = breakLines(flatten(child.content, PLAIN), body, textWidth - indent);
        ts.lines(lines, left + indent, body, body * 1.35, {
          text: marker,
          x: left + 4,
          body: ["LBody", "P"],
        });
        ts.end(); // P
        ts.space(body * 0.15);
      } else {
        if (c === 0)
          ts.lines([{ segments: [], width: 0 }], left + indent, body, body * 1.35, {
            text: marker,
            x: left + 4,
            body: ["LBody"],
          });
        layoutBlocks(ts, [child], left + indent, true);
      }
    });
    if (Arr.isReadonlyArrayNonEmpty(item)) ts.end(); // LBody
    ts.end(); // LI
  });
  ts.end(); // L
  if (!tight) ts.space(body * 0.65);
};

/** Lay out a sequence of blocks; blocks outside the PDF profile (narrowing removes them first) are skipped. */
const layoutBlocks = (
  ts: Typesetter,
  blocks: ReadonlyArray<Block>,
  left: number,
  tight = false,
): void => {
  blocks.forEach((b, i) => {
    if (isNodeIn(Pdf, b)) layoutBlock(ts, b, left, tight, i === blocks.length - 1);
  });
};

/**
 * Lay out one block of the PDF profile; `last`: it ends its sequence.
 * Exhaustive over the profile's blocks (#109).
 */
const layoutBlock = (
  ts: Typesetter,
  b: BlockOf<PdfFeature>,
  left: number,
  tight: boolean,
  last: boolean,
): void => {
  const body = ts.body;
  const textWidth = ts.width - 2 * ts.margin - left;
  const paragraph = (p: { readonly content: ReadonlyArray<Inline> }, isPara: boolean): void => {
    const lines = breakLines(flatten(p.content, PLAIN), body, textWidth);
    ts.begin("P");
    ts.lines(lines, left, body, body * 1.35);
    ts.end();
    if (!tight || !last) ts.space(isPara ? body * 0.8 : tight ? body * 0.3 : body * 0.8);
  };
  Match.valueTags(b, {
    Para: (p) => paragraph(p, true),
    Plain: (p) => paragraph(p, false),
    Header: (h) => {
      const size = HEADING_SIZES[h.level - 1] ?? body;
      ts.space(size * 0.6);
      const lines = breakLines(flatten(h.content, { ...PLAIN, bold: true }), size, textWidth);
      ts.begin(`H${h.level}`);
      const at = ts.lines(lines, left, size, size * 1.25);
      ts.end();
      const title = inlinesToText(h.content).replace(/\s+/g, " ").trim();
      if (title !== "") ts.headings.push({ level: h.level, title, at });
      ts.space(size * 0.4);
    },
    CodeBlock: (c) => layoutCodeBlock(ts, c, left, textWidth),
    BulletList: (l) => layoutList(ts, l, left, textWidth, tight),
    OrderedList: (l) => layoutList(ts, l, left, textWidth, tight),
    BlockQuote: (q) => {
      const start = ts.position;
      ts.begin("BlockQuote");
      layoutBlocks(ts, q.content, left + 24);
      ts.end();
      const end = ts.position;
      if (start.page === end.page) ts.bar(left + 8, start.y, end.y + body * 0.8);
    },
    HorizontalRule: () => {
      ts.rule(left);
      ts.space(body * 0.5);
    },
  });
};

// ============================================================================
// File assembly
// ============================================================================

const metaString = (meta: Meta, key: string): PdfObject | undefined => {
  const v = meta[key];
  return Predicate.isString(v) && v !== "" ? pdfTextString(v) : undefined;
};

/** The metadata as JSON text, a stable input to the file identifier. */
const MetaJson = Schema.fromJsonString(Schema.Unknown);

/**
 * Write the structure elements under `root` (the `Document` element), each a
 * `/StructElem` whose kids are elements, marked content (an MCID on the
 * element's own page, or a marked-content reference on another) and link
 * annotations (object references).
 */
const writeStructure = (
  pdf: PdfBuilder,
  root: StructNode,
  treeRef: PdfRef,
  structRef: (node: StructNode) => PdfRef,
  pages: ReadonlyArray<PdfRef>,
  annots: ReadonlyArray<ReadonlyArray<PdfRef>>,
): void => {
  // (recursive, as the layout is: the structure nests as deep as the document)
  const write = (node: StructNode, parent: PdfRef): void => {
    const ownPage = node.kids.flatMap((k) => (Predicate.isTagged(k, "Content") ? [k.page] : []))[0];
    const kids = node.kids.map((kid): PdfObject =>
      Match.valueTags(kid, {
        Node: ({ node: child }) => structRef(child),
        Content: ({ page, mcid }) =>
          page === ownPage ? mcid : pdfDict({ Type: pdfName("MCR"), Pg: pages[page], MCID: mcid }),
        Annot: ({ page, link }) =>
          pdfDict({ Type: pdfName("OBJR"), Obj: annots[page]?.[link], Pg: pages[page] }),
      }),
    );
    pdf.set(
      structRef(node),
      pdfDict({
        Type: pdfName("StructElem"),
        S: pdfName(node.type),
        P: parent,
        Pg: ownPage === undefined ? undefined : pages[ownPage],
        K: pdfArray(kids),
        A: node.attributes,
      }),
    );
    node.kids.forEach((kid) => {
      if (Predicate.isTagged(kid, "Node")) write(kid.node, structRef(node));
    });
  };
  write(root, treeRef);
};

/** An outline item and the items nested under it (deeper headings that follow it). */
interface OutlineNode {
  readonly entry: OutlineEntry;
  readonly children: OutlineNode[];
}

/** Nest headings by level: each one goes under the nearest earlier heading of a lower level. */
const outlineTree = (headings: ReadonlyArray<OutlineEntry>): OutlineNode[] => {
  const roots: OutlineNode[] = [];
  const open: OutlineNode[] = [];
  headings.forEach((entry) => {
    const node: OutlineNode = { entry, children: [] };
    const parentAt = open.findLastIndex((o) => o.entry.level < entry.level);
    open.splice(parentAt + 1);
    const parent = open[open.length - 1];
    if (parent === undefined) roots.push(node);
    else parent.children.push(node);
    open.push(node);
  });
  return roots;
};

/** The number of items under a node, all open. */
const descendants = (node: OutlineNode): number =>
  node.children.reduce((n, child) => n + 1 + descendants(child), 0);

/**
 * Write the document outline (bookmarks) from the headings (#20): one item
 * per heading, nested by level, each going to the top of its first line.
 * `undefined` when there are no headings.
 */
const writeOutline = (
  pdf: PdfBuilder,
  headings: ReadonlyArray<OutlineEntry>,
  pages: ReadonlyArray<PdfRef>,
): PdfRef | undefined => {
  const roots = outlineTree(headings);
  if (Arr.isReadonlyArrayEmpty(roots)) return undefined;
  const root = pdf.alloc();
  const items = (nodes: ReadonlyArray<OutlineNode>, parent: PdfRef): readonly [PdfRef, PdfRef] => {
    const refs = nodes.map(() => pdf.alloc());
    nodes.forEach((node, i) => {
      const ref = refs[i] ?? parent;
      const [first, last] = Arr.isReadonlyArrayNonEmpty(node.children)
        ? items(node.children, ref)
        : [undefined, undefined];
      const page = pages[node.entry.at.page];
      pdf.set(
        ref,
        pdfDict({
          Title: pdfTextString(node.entry.title),
          Parent: parent,
          Prev: refs[i - 1],
          Next: refs[i + 1],
          First: first,
          Last: last,
          Count: Arr.isReadonlyArrayNonEmpty(node.children) ? descendants(node) : undefined,
          Dest:
            page === undefined
              ? undefined
              : pdfArray([
                  page,
                  pdfName("XYZ"),
                  null,
                  Math.round(node.entry.at.top * 100) / 100,
                  null,
                ]),
        }),
      );
    });
    return [refs[0] ?? parent, refs[refs.length - 1] ?? parent];
  };
  const [first, last] = items(roots, root);
  pdf.set(
    root,
    pdfDict({
      Type: pdfName("Outlines"),
      First: first,
      Last: last,
      Count: roots.reduce((n, node) => n + 1 + descendants(node), 0),
    }),
  );
  return root;
};

/** Render a PDF-profile document to PDF bytes. */
export const renderPdf = (doc: Doc<PdfFeature>, options: PdfWriterOptions = {}): Uint8Array => {
  const pageSize = options.pageSize;
  const [width, height] =
    pageSize === undefined || Predicate.isString(pageSize)
      ? PAGE_SIZES[pageSize ?? "a4"]
      : pageSize;
  const ts = new Typesetter(width, height, options.margin ?? 72, options.fontSize ?? 11);
  layoutBlocks(ts, doc.blocks, 0);
  ts.endMarked();

  const pdf = new PdfBuilder();
  const catalogRef = pdf.alloc();
  const pagesRef = pdf.alloc();
  const fontRefs: Record<string, PdfRef> = {};
  for (const font of Arr.sort(Array.from(ts.fonts), Order.String)) {
    fontRefs[fontKey(font)] = pdf.add(
      pdfDict({
        Type: pdfName("Font"),
        Subtype: pdfName("Type1"),
        BaseFont: pdfName(font),
        Encoding: pdfName("WinAnsiEncoding"),
      }),
    );
  }
  const resources = pdfDict({
    Font: pdfDict(fontRefs),
    ProcSet: pdfArray([pdfName("PDF"), pdfName("Text")]),
  });

  const treeRef = pdf.alloc();
  // page i's marked content is ParentTree key i; the link annotations follow
  const kids: PdfRef[] = ts.pages.map(() => pdf.alloc());
  const structRefs = Array.from({ length: ts.elements }, () => pdf.alloc());
  const structRef = (node: StructNode): PdfRef => structRefs[node.id] ?? treeRef;
  const annotRefs: PdfRef[][] = [];
  const linkParents: PdfObject[] = [];
  Arr.zip(ts.pages, kids).forEach(([page, pageRef], i) => {
    const content = latin1ToBytes(page.ops.join("\n"));
    const contentRef = pdf.add(
      options.compress === false ? pdfStream(pdfDict(), content) : flateStream(content),
    );
    const annots = page.links.map(({ rect, url, owner }) => {
      linkParents.push(ts.pages.length + linkParents.length, structRef(owner));
      return pdf.add(
        pdfDict({
          Type: pdfName("Annot"),
          Subtype: pdfName("Link"),
          Rect: pdfArray(rect.map((n) => Math.round(n * 100) / 100)),
          Border: pdfArray([0, 0, 0]),
          A: pdfDict({ Type: pdfName("Action"), S: pdfName("URI"), URI: pdfTextString(url) }),
          StructParent: ts.pages.length + (linkParents.length / 2 - 1),
        }),
      );
    });
    annotRefs.push(annots);
    pdf.set(
      pageRef,
      pdfDict({
        Type: pdfName("Page"),
        Parent: pagesRef,
        MediaBox: pdfArray([0, 0, width, height]),
        Resources: resources,
        Contents: contentRef,
        Annots: Arr.isReadonlyArrayNonEmpty(annots) ? pdfArray(annots) : undefined,
        StructParents: i,
        // the tab order follows the structure
        Tabs: pdfName("S"),
      }),
    );
  });
  pdf.set(pagesRef, pdfDict({ Type: pdfName("Pages"), Kids: pdfArray(kids), Count: kids.length }));

  writeStructure(pdf, ts.root, treeRef, structRef, kids, annotRefs);
  const parentTree = pdfDict({
    Nums: pdfArray([
      ...ts.pages.flatMap((page, i) => [i, pdfArray(page.mcids.map(structRef))]),
      ...linkParents,
    ]),
  });
  pdf.set(
    treeRef,
    pdfDict({
      Type: pdfName("StructTreeRoot"),
      K: structRef(ts.root),
      ParentTree: parentTree,
      ParentTreeNextKey: ts.pages.length + linkParents.length / 2,
    }),
  );
  pdf.set(
    catalogRef,
    pdfDict({
      Type: pdfName("Catalog"),
      Pages: pagesRef,
      MarkInfo: pdfDict({ Marked: true }),
      Outlines: writeOutline(pdf, ts.headings, kids),
      StructTreeRoot: treeRef,
      Lang: metaString(doc.meta, "lang") ?? metaString(doc.meta, "language"),
    }),
  );

  const meta = doc.meta;
  const info = pdf.add(
    pdfDict({
      Title: metaString(meta, "title"),
      Author: metaString(meta, "author"),
      Subject: metaString(meta, "subject"),
      Keywords: metaString(meta, "keywords"),
      Producer: pdfTextString("effect-document"),
    }),
  );
  const seed = latin1ToBytes(
    Schema.encodeSync(MetaJson)(meta) + ts.pages.map((p) => p.ops.join("")).join(""),
  );
  return pdf.build({ root: catalogRef, info, extra: { ID: fileId(seed) }, version: "1.7" });
};

/** Create a PDF Writer. */
export const makePdfWriter = (options: PdfWriterOptions = {}): Writer<PdfFeature> => {
  const write = (doc: Doc<PdfFeature>): Effect.Effect<Content, WriteError> =>
    Effect.try({
      try: () => bytes(renderPdf(doc, options)),
      catch: (cause) =>
        new WriteError({
          format: "pdf",
          reason: describeCause(cause),
          cause,
        }),
    });
  return { format: "pdf", profile: Pdf, write };
};

/** The Context tag for the PDF writer, so a program can depend on a PDF writer and have one provided. */
export const PdfWriterTag = makeWriterTag<PdfFeature>("pdf");
/** A Layer providing the default PDF writer for {@link PdfWriterTag}. */
export const PdfWriterLive = Layer.succeed(PdfWriterTag, makePdfWriter());
