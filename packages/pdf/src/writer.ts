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

interface PageOut {
  readonly ops: string[];
  readonly links: Array<{ rect: [number, number, number, number]; url: string }>;
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

class Typesetter {
  readonly pages: PageOut[] = [];
  readonly fonts = new Set<StandardFont>();
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
    this.page = { ops: [], links: [] };
    this.pages.push(this.page);
    this.y = this.top;
  }

  /** Leave vertical space (not at the top of a page). */
  space(amount: number): void {
    if (this.y < this.top) this.y -= amount;
  }

  /** Make sure `amount` fits on the page, or start a new one. */
  private need(amount: number): void {
    if (this.y - amount < this.bottom && this.y < this.top) this.newPage();
  }

  /** Set laid-out lines at a left offset, with a line height. */
  lines(
    lines: ReadonlyArray<LaidLine>,
    left: number,
    size: number,
    lineHeight: number,
    marker?: { text: string; x: number },
  ): void {
    const ascent = size * 0.75;
    lines.forEach((line, i) => {
      this.need(lineHeight);
      const baseline = this.y - ascent - (lineHeight - size) / 2;
      if (i === 0 && marker !== undefined)
        this.text(marker.text, PLAIN, size, this.margin + marker.x, baseline);
      for (const seg of line.segments)
        this.text(seg.text, seg.style, size, this.margin + left + seg.x, baseline, seg.width);
      this.y -= lineHeight;
    });
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
    const ops = this.page.ops;
    if (style.url !== undefined) ops.push("0 0 0.6 rg");
    ops.push(`BT /${fontKey(font)} ${num(size)} Tf ${num(x)} ${num(y)} Td ${pdfText(text)} Tj ET`);
    if (style.url !== undefined) ops.push("0 g");
    const w = width ?? measure(text, font, size);
    const rule = (dy: number): void => {
      ops.push(`${num(size / 18)} w ${num(x)} ${num(y + dy)} m ${num(x + w)} ${num(y + dy)} l S`);
    };
    if (style.underline) rule(-size * 0.12);
    if (style.strike) rule(size * 0.3);
    if (style.url !== undefined)
      this.page.links.push({ rect: [x, y - size * 0.22, x + w, y + size * 0.8], url: style.url });
  }

  /** A horizontal rule across the text width. */
  rule(left: number): void {
    this.need(this.body);
    const y = this.y - this.body / 2;
    this.page.ops.push(
      `0.5 w ${num(this.margin + left)} ${num(y)} m ${num(this.width - this.margin)} ${num(y)} l S`,
    );
    this.y -= this.body;
  }

  /** A vertical bar beside a block quote, from `fromY` to the current position. */
  bar(x: number, fromY: number, toY: number): void {
    this.page.ops.push(`0.6 g ${num(this.margin + x)} ${num(toY)} 2 ${num(fromY - toY)} re f 0 g`);
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
  ts.lines(out, left, size, size * 1.3);
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
  b.items.forEach((item, k) => {
    const marker = Predicate.isTagged(b, "BulletList") ? "•" : `${(b.start ?? 1) + k}.`;
    item.forEach((child, c) => {
      if (c === 0 && (Predicate.isTagged(child, "Plain") || Predicate.isTagged(child, "Para"))) {
        const lines = breakLines(flatten(child.content, PLAIN), body, textWidth - indent);
        ts.lines(lines, left + indent, body, body * 1.35, { text: marker, x: left + 4 });
        ts.space(body * 0.15);
      } else {
        if (c === 0)
          ts.lines([{ segments: [], width: 0 }], left + indent, body, body * 1.35, {
            text: marker,
            x: left + 4,
          });
        layoutBlocks(ts, [child], left + indent, true);
      }
    });
  });
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
    ts.lines(lines, left, body, body * 1.35);
    if (!tight || !last) ts.space(isPara ? body * 0.8 : tight ? body * 0.3 : body * 0.8);
  };
  Match.valueTags(b, {
    Para: (p) => paragraph(p, true),
    Plain: (p) => paragraph(p, false),
    Header: (h) => {
      const size = HEADING_SIZES[h.level - 1] ?? body;
      ts.space(size * 0.6);
      const lines = breakLines(flatten(h.content, { ...PLAIN, bold: true }), size, textWidth);
      ts.lines(lines, left, size, size * 1.25);
      ts.space(size * 0.4);
    },
    CodeBlock: (c) => layoutCodeBlock(ts, c, left, textWidth),
    BulletList: (l) => layoutList(ts, l, left, textWidth, tight),
    OrderedList: (l) => layoutList(ts, l, left, textWidth, tight),
    BlockQuote: (q) => {
      const start = ts.position;
      layoutBlocks(ts, q.content, left + 24);
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

/** Render a PDF-profile document to PDF bytes. */
export const renderPdf = (doc: Doc<PdfFeature>, options: PdfWriterOptions = {}): Uint8Array => {
  const pageSize = options.pageSize;
  const [width, height] =
    pageSize === undefined || Predicate.isString(pageSize)
      ? PAGE_SIZES[pageSize ?? "a4"]
      : pageSize;
  const ts = new Typesetter(width, height, options.margin ?? 72, options.fontSize ?? 11);
  layoutBlocks(ts, doc.blocks, 0);

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

  const kids: PdfRef[] = [];
  for (const page of ts.pages) {
    const content = latin1ToBytes(page.ops.join("\n"));
    const contentRef = pdf.add(
      options.compress === false ? pdfStream(pdfDict(), content) : flateStream(content),
    );
    const annots = page.links.map(({ rect, url }) =>
      pdf.add(
        pdfDict({
          Type: pdfName("Annot"),
          Subtype: pdfName("Link"),
          Rect: pdfArray(rect.map((n) => Math.round(n * 100) / 100)),
          Border: pdfArray([0, 0, 0]),
          A: pdfDict({ Type: pdfName("Action"), S: pdfName("URI"), URI: pdfTextString(url) }),
        }),
      ),
    );
    kids.push(
      pdf.add(
        pdfDict({
          Type: pdfName("Page"),
          Parent: pagesRef,
          MediaBox: pdfArray([0, 0, width, height]),
          Resources: resources,
          Contents: contentRef,
          Annots: Arr.isReadonlyArrayNonEmpty(annots) ? pdfArray(annots) : undefined,
        }),
      ),
    );
  }
  pdf.set(pagesRef, pdfDict({ Type: pdfName("Pages"), Kids: pdfArray(kids), Count: kids.length }));
  pdf.set(catalogRef, pdfDict({ Type: pdfName("Catalog"), Pages: pagesRef }));

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
