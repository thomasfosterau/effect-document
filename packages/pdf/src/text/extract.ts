/**
 * Positioned text from page content streams (ISO 32000-2 §8.4, §9.3-9.4).
 *
 * A small interpreter runs a page's content stream - and the Form XObjects it
 * paints - tracking the graphics state (`q`/`Q`/`cm`) and text state (`BT`,
 * `Tf`, `Tm`, `Td`, `Tc`, `Tw`, `Tz`, `TL`, `Ts`, ...) and emits every shown
 * glyph with its Unicode text, its position in (rotation-corrected) page
 * space, its advance and its effective font size. `/ActualText` replacements
 * in marked content are honoured. Link annotations come back too, so the
 * layout step can attach URLs to the text under them.
 */

import * as Rec from "effect/Record";
import * as Option from "effect/Option";
import * as HashMap from "effect/HashMap";
import * as Result from "effect/Result";
import * as Match from "effect/Match";
import * as Predicate from "effect/Predicate";
import type { PdfFile, PdfPage } from "../cos/file.ts";
import {
  type PdfDict,
  type PdfObject,
  type PdfStream,
  dictOf,
  isArray,
  isDict,
  isName,
  isRef,
  isStream,
  isString,
} from "../cos/objects.ts";
import { type Operation, parseContentStream } from "../cos/parser.ts";
import { decodeTextString } from "./encodings.ts";
import { type PdfFont, loadFont } from "./font.ts";

/** A shown glyph, positioned on the page (origin bottom-left, y up). */
export interface TextGlyph {
  /** Unicode text (possibly empty, or several characters). */
  readonly text: string;
  /** Baseline origin. */
  readonly x: number;
  readonly y: number;
  /** Horizontal advance of the glyph itself (without character/word spacing). */
  readonly width: number;
  /** Effective font size on the page. */
  readonly size: number;
  readonly bold: boolean;
  readonly italic: boolean;
  readonly monospace: boolean;
  /** Whether the text runs left to right along the page's x axis. */
  readonly upright: boolean;
}

/** A URI link annotation. */
export interface PageLink {
  /** `[x0, y0, x1, y1]` in the same space as the glyphs. */
  readonly rect: readonly [number, number, number, number];
  readonly url: string;
}

/** A page's positioned text and links. */
export interface PageText {
  readonly width: number;
  readonly height: number;
  readonly glyphs: ReadonlyArray<TextGlyph>;
  readonly links: ReadonlyArray<PageLink>;
}

type Matrix = readonly [number, number, number, number, number, number];

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** `m1 × m2`: apply m1, then m2. */
const mul = (m1: Matrix, m2: Matrix): Matrix => [
  m1[0] * m2[0] + m1[1] * m2[2],
  m1[0] * m2[1] + m1[1] * m2[3],
  m1[2] * m2[0] + m1[3] * m2[2],
  m1[2] * m2[1] + m1[3] * m2[3],
  m1[4] * m2[0] + m1[5] * m2[2] + m2[4],
  m1[4] * m2[1] + m1[5] * m2[3] + m2[5],
];

const apply = (m: Matrix, x: number, y: number): [number, number] => [
  m[0] * x + m[2] * y + m[4],
  m[1] * x + m[3] * y + m[5],
];

const toMatrix = (operands: ReadonlyArray<PdfObject>): Matrix | undefined => {
  const [a, b, c, d, e, f] = operands;
  return Predicate.isNumber(a) &&
    Predicate.isNumber(b) &&
    Predicate.isNumber(c) &&
    Predicate.isNumber(d) &&
    Predicate.isNumber(e) &&
    Predicate.isNumber(f)
    ? [a, b, c, d, e, f]
    : undefined;
};

/** The matrix taking user space to an upright page with its origin at the bottom-left. */
const pageMatrix = (page: PdfPage): { matrix: Matrix; width: number; height: number } => {
  const [x0, y0, x1, y1] = page.mediaBox;
  const w = x1 - x0;
  const h = y1 - y0;
  const origin: Matrix = [1, 0, 0, 1, -x0, -y0];
  return Match.value(page.rotate).pipe(
    Match.when(90, () => {
      return { matrix: mul(origin, [0, -1, 1, 0, 0, w]), width: h, height: w };
    }),
    Match.when(180, () => {
      return { matrix: mul(origin, [-1, 0, 0, -1, w, h]), width: w, height: h };
    }),
    Match.when(270, () => {
      return { matrix: mul(origin, [0, 1, -1, 0, h, 0]), width: h, height: w };
    }),
    Match.orElse(() => {
      return { matrix: origin, width: w, height: h };
    }),
  );
};

interface TextState {
  font: PdfFont | undefined;
  size: number;
  charSpace: number;
  wordSpace: number;
  scale: number;
  leading: number;
  rise: number;
}

interface GState {
  ctm: Matrix;
  text: TextState;
}

const MAX_FORM_DEPTH = 12;

/** Applies one content-stream operator; `n(i)` reads operand `i` as a number (0 if absent). */
type OperatorHandler = (operands: ReadonlyArray<PdfObject>, n: (i: number) => number) => void;

/** Extract the positioned text of one page. */
export const extractPageText = (file: PdfFile, page: PdfPage): PageText => {
  const { matrix: base, width, height } = pageMatrix(page);
  const glyphs: TextGlyph[] = [];
  const fonts = new Map<PdfObject | number, PdfFont>();

  const fontFor = (resources: PdfDict | undefined, name: string): PdfFont | undefined => {
    const ref = file.lookupDict(resources, "Font")?.entries.get(name);
    if (ref === undefined) return undefined;
    const key = isRef(ref) ? ref.num : ref; // shared fonts are loaded once
    let f = fonts.get(key);
    if (f === undefined) {
      f = loadFont(file, ref);
      fonts.set(key, f);
    }
    return f;
  };

  const run = (
    ops: ReadonlyArray<Operation>,
    resources: PdfDict | undefined,
    initial: Matrix,
    depth: number,
    forms: Set<PdfStream>,
  ): void => {
    let gs: GState = {
      ctm: initial,
      text: { font: undefined, size: 0, charSpace: 0, wordSpace: 0, scale: 1, leading: 0, rise: 0 },
    };
    const stack: GState[] = [];
    let tm: Matrix = IDENTITY;
    let tlm: Matrix = IDENTITY;
    // /ActualText replacement: the glyphs shown inside the marked span
    const marked: Array<{ actual?: string | undefined; start: number }> = [];

    const show = (bytes: Uint8Array): void => {
      const ts = gs.text;
      const font = ts.font;
      if (font === undefined) return;
      for (const g of font.decode(bytes)) {
        const trm = mul([ts.size * ts.scale, 0, 0, ts.size, 0, ts.rise], mul(tm, gs.ctm));
        const [x, y] = apply(trm, 0, 0);
        const [ex, ey] = apply(trm, g.width, 0);
        const size = Math.hypot(trm[2], trm[3]);
        glyphs.push({
          text: g.text,
          x,
          y,
          width: Math.hypot(ex - x, ey - y),
          size,
          bold: font.bold,
          italic: font.italic,
          monospace: font.monospace,
          upright: Math.abs(ey - y) <= Math.abs(ex - x) * 0.05 + 1e-6 && ex >= x,
        });
        const tx = (g.width * ts.size + ts.charSpace + (g.wordSpace ? ts.wordSpace : 0)) * ts.scale;
        tm = mul([1, 0, 0, 1, tx, 0], tm);
      }
    };

    const nextLine = (tx: number, ty: number): void => {
      tlm = mul([1, 0, 0, 1, tx, ty], tlm);
      tm = tlm;
    };

    /** One handler per content-stream operator; unknown operators are ignored. */
    const operators = HashMap.fromIterable<string, OperatorHandler>(
      Rec.toEntries({
        q: () => {
          stack.push({ ctm: gs.ctm, text: { ...gs.text } });
        },
        Q: () => {
          gs = stack.pop() ?? gs;
        },
        cm: (operands) => {
          const m = toMatrix(operands);
          if (m !== undefined) gs = { ...gs, ctm: mul(m, gs.ctm) };
        },
        BT: () => {
          tm = IDENTITY;
          tlm = IDENTITY;
        },
        Tc: (operands, n) => {
          gs.text.charSpace = n(0);
        },
        Tw: (operands, n) => {
          gs.text.wordSpace = n(0);
        },
        Tz: (operands, n) => {
          gs.text.scale = n(0) / 100;
        },
        TL: (operands, n) => {
          gs.text.leading = n(0);
        },
        Ts: (operands, n) => {
          gs.text.rise = n(0);
        },
        Tf: (operands, n) => {
          const name = operands[0];
          if (isName(name)) gs.text.font = fontFor(resources, name.name);
          gs.text.size = n(1);
        },
        Td: (operands, n) => {
          nextLine(n(0), n(1));
        },
        TD: (operands, n) => {
          gs.text.leading = -n(1);
          nextLine(n(0), n(1));
        },
        Tm: (operands) => {
          const m = toMatrix(operands);
          if (m !== undefined) {
            tm = m;
            tlm = m;
          }
        },
        "T*": () => {
          nextLine(0, -gs.text.leading);
        },
        Tj: (operands) => {
          const s = operands[0];
          if (isString(s)) show(s.bytes);
        },
        "'": (operands) => {
          nextLine(0, -gs.text.leading);
          const s = operands[0];
          if (isString(s)) show(s.bytes);
        },
        '"': (operands, n) => {
          gs.text.wordSpace = n(0);
          gs.text.charSpace = n(1);
          nextLine(0, -gs.text.leading);
          const s = operands[2];
          if (isString(s)) show(s.bytes);
        },
        TJ: (operands) => {
          const a = operands[0];
          if (!isArray(a)) return;
          for (const item of a.items) {
            if (isString(item)) show(item.bytes);
            else if (Predicate.isNumber(item)) {
              const tx = (-item / 1000) * gs.text.size * gs.text.scale;
              tm = mul([1, 0, 0, 1, tx, 0], tm);
            }
          }
        },
        gs: (operands) => {
          const name = operands[0];
          const ext = isName(name)
            ? file.lookupDict(file.lookupDict(resources, "ExtGState"), name.name)
            : undefined;
          const f = file.lookupArray(ext, "Font");
          if (f !== undefined) {
            const size = file.resolve(f.items[1]);
            gs.text.font = loadFont(file, f.items[0]);
            if (Predicate.isNumber(size)) gs.text.size = size;
          }
        },
        Do: (operands) => {
          const name = operands[0];
          if (!isName(name) || depth >= MAX_FORM_DEPTH) return;
          const xobj = file.lookup(file.lookupDict(resources, "XObject"), name.name);
          if (
            !isStream(xobj) ||
            file.lookupName(xobj.dict, "Subtype") !== "Form" ||
            forms.has(xobj)
          )
            return;
          const parsed = Result.try(() => parseContentStream(file.decode(xobj).data));
          if (Result.isFailure(parsed)) return;
          const contents = parsed.success;
          const m =
            toMatrix(
              file.lookupArray(xobj.dict, "Matrix")?.items.map((x) => file.resolve(x) ?? 0) ?? [],
            ) ?? IDENTITY;
          forms.add(xobj);
          run(
            contents,
            file.lookupDict(xobj.dict, "Resources") ?? resources,
            mul(m, gs.ctm),
            depth + 1,
            forms,
          );
          forms.delete(xobj);
        },
        BMC: () => {
          marked.push({ start: glyphs.length });
        },
        BDC: (operands) => {
          let props = operands[1];
          if (isName(props))
            props = file.lookup(file.lookupDict(resources, "Properties"), props.name);
          const actual = isDict(props) ? file.resolve(props.entries.get("ActualText")) : undefined;
          marked.push({
            start: glyphs.length,
            actual: isString(actual) ? decodeTextString(actual.bytes) : undefined,
          });
        },
        EMC: () => {
          const m = marked.pop();
          if (m?.actual === undefined || m.start >= glyphs.length) return;
          // the replacement text goes on the first glyph; the rest are silenced
          const first = glyphs[m.start]!;
          glyphs[m.start] = { ...first, text: m.actual };
          for (let i = m.start + 1; i < glyphs.length; i++) glyphs[i] = { ...glyphs[i]!, text: "" };
        },
      }),
    );

    for (const { op, operands } of ops) {
      const n = (i: number): number => {
        const v = operands[i];
        return Predicate.isNumber(v) ? v : 0;
      };
      const handler = HashMap.get(operators, op);
      if (Option.isSome(handler)) handler.value(operands, n);
    }
  };

  run(contentOf(file, page), page.resources, base, 0, new Set());
  return { width, height, glyphs, links: linksOf(file, page, base) };
};

/** A page's content operations (its `/Contents` streams, concatenated). */
const contentOf = (file: PdfFile, page: PdfPage): Operation[] => {
  const contents = file.lookup(page.dict, "Contents");
  const streams = isArray(contents) ? contents.items.map((c) => file.resolve(c)) : [contents];
  const parts: Uint8Array[] = [];
  for (const s of streams) {
    if (!isStream(s)) continue;
    // skip an undecodable content stream
    Result.try(() => {
      parts.push(file.decode(s).data, Uint8Array.of(0x0a));
    });
  }
  let length = 0;
  for (const p of parts) length += p.length;
  const all = new Uint8Array(length);
  let pos = 0;
  for (const p of parts) {
    all.set(p, pos);
    pos += p.length;
  }
  return parseContentStream(all);
};

const linksOf = (file: PdfFile, page: PdfPage, base: Matrix): PageLink[] => {
  const links: PageLink[] = [];
  for (const a of file.lookupArray(page.dict, "Annots")?.items ?? []) {
    const annot = dictOf(file.resolve(a));
    if (annot === undefined || file.lookupName(annot, "Subtype") !== "Link") continue;
    const action = file.lookupDict(annot, "A");
    const uri = file.lookup(action, "URI");
    if (file.lookupName(action, "S") !== "URI" || !isString(uri)) continue;
    const r = file.lookupArray(annot, "Rect")?.items.map((x) => file.resolve(x));
    if (r === undefined || !r.every((x) => Predicate.isNumber(x))) continue;
    const [x0, y0, x1, y1] = r;
    if (
      !Predicate.isNumber(x0) ||
      !Predicate.isNumber(y0) ||
      !Predicate.isNumber(x1) ||
      !Predicate.isNumber(y1)
    )
      continue; // fewer than four numbers
    const [ax, ay] = apply(base, x0, y0);
    const [bx, by] = apply(base, x1, y1);
    links.push({
      rect: [Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)],
      url: decodeTextString(uri.bytes),
    });
  }
  return links;
};
