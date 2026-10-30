/**
 * The PPTX Reader: .pptx bytes -> a presentation document in the PPTX read profile.
 *
 * Walks `ppt/presentation.xml` for the ordered slide list, then each slide's
 * shape tree: every `<p:sp>` (including those inside `<p:grpSp>` groups, which
 * are flattened in document order) becomes a TextBox (or a Placeholder, if it
 * carries a `<p:ph>`), whose text body is read back into paragraphs/lists with
 * bold/italic/underline/strike runs. Paragraph `lvl` nests bullet lists, an
 * unbulleted paragraph at an open list's `marL` continues its last item, and
 * the paragraphs of title placeholders become level-1 headers. A slide whose
 * relationship or part is missing fails the read, as in XLSX.
 */

import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  type Block,
  type Content,
  contentToBytes,
  type Doc,
  document,
  Emph,
  Header,
  type Inline,
  LineBreak,
  makeReaderTag,
  Para,
  ParseError,
  Placeholder,
  Plain,
  type Reader,
  type Shape,
  Slide,
  SlideShow,
  Str,
  Strikeout,
  Strong,
  TextBox,
  trustAs,
  Underline,
} from "@thomasfosterau/effect-document";
import {
  OpcError,
  type OpcLimits,
  OpcReader,
  type XmlElement,
  findChild,
  findChildren,
  getAttr,
  ListStack,
  ooxmlParseError,
} from "../shared/index.ts";
import { PptxRead, type PptxReadFeature } from "./profile.ts";

/** Options for the PPTX reader: zip resource limits. */
export interface PptxReaderOptions {
  /** Zip-bomb limits (entry count, entry size, total size); see `OpcLimits`. */
  readonly limits?: OpcLimits | undefined;
}

/** Main-part content types this reader accepts. */
const MAIN_CONTENT_TYPES = [
  "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml",
  "application/vnd.ms-powerpoint.presentation.macroEnabled.main+xml",
  "application/vnd.openxmlformats-officedocument.presentationml.slideshow.main+xml",
  "application/vnd.ms-powerpoint.slideshow.macroEnabled.main+xml",
  "application/vnd.openxmlformats-officedocument.presentationml.template.main+xml",
  "application/vnd.ms-powerpoint.template.macroEnabled.main+xml",
];

interface Fmt {
  b: boolean;
  i: boolean;
  u: boolean;
  strike: boolean;
}

const wrap = (node: Inline, f: Fmt): Inline => {
  let x = node;
  if (f.i) x = new Emph({ content: [x] });
  if (f.b) x = new Strong({ content: [x] });
  if (f.u) x = new Underline({ content: [x] });
  if (f.strike) x = new Strikeout({ content: [x] });
  return x;
};

/** An `xsd:boolean` attribute: "true"/"1" or "false"/"0". */
const isTrue = (v: string | undefined): boolean => v === "1" || v === "true";

const runFmt = (r: XmlElement): Fmt => {
  const rPr = findChild(r, "rPr");
  const attr = (name: string): string | undefined =>
    rPr === undefined ? undefined : getAttr(rPr, name);
  return {
    b: isTrue(attr("b")),
    i: isTrue(attr("i")),
    u: attr("u") !== undefined && attr("u") !== "none",
    strike: attr("strike") !== undefined && attr("strike") !== "noStrike",
  };
};

const paragraphInlines = (p: XmlElement): Inline[] => {
  const out: Inline[] = [];
  for (const child of p.children) {
    // Fields (slide numbers, dates) carry their current text like a run.
    if (child.name === "r" || child.name === "fld") {
      const f = runFmt(child);
      const t = findChild(child, "t");
      if (t !== undefined) out.push(wrap(new Str({ text: t.text }), f));
    } else if (child.name === "br") {
      out.push(new LineBreak());
    }
  }
  return out;
};

type Bullet = "bullet" | "ordered" | null;

const paragraphBullet = (p: XmlElement): Bullet => {
  const pPr = findChild(p, "pPr");
  if (pPr === undefined) return null;
  if (findChild(pPr, "buAutoNum") !== undefined) return "ordered";
  if (findChild(pPr, "buChar") !== undefined) return "bullet";
  return null;
};

/** An integer attribute of the paragraph's `a:pPr`, if it has a valid one. */
const pPrInt = (pPr: XmlElement | undefined, name: string): number | undefined => {
  const v = pPr === undefined ? undefined : getAttr(pPr, name);
  const n = v === undefined ? Number.NaN : Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : undefined;
};

/** The paragraph's left margin, `a:pPr@marL` in EMU, if it sets one. */
const paragraphMargin = (p: XmlElement): number | undefined => pPrInt(findChild(p, "pPr"), "marL");

/** Where an auto-numbered paragraph's numbering (re)starts, `a:buAutoNum@startAt`, if it says. */
const paragraphStartAt = (p: XmlElement): number | undefined => {
  const pPr = findChild(p, "pPr");
  return pPrInt(pPr === undefined ? undefined : findChild(pPr, "buAutoNum"), "startAt");
};

/** The paragraph's indent level, `a:pPr@lvl` (0-8). */
const paragraphLevel = (p: XmlElement): number => {
  const pPr = findChild(p, "pPr");
  const lvl = pPr === undefined ? undefined : getAttr(pPr, "lvl");
  const n = lvl === undefined ? 0 : Number.parseInt(lvl, 10);
  return Number.isFinite(n) ? Math.min(Math.max(n, 0), 8) : 0;
};

const txBodyToBlocks = (txBody: XmlElement, asHeaders: boolean): Block[] => {
  const lists = new ListStack();
  for (const p of findChildren(txBody, "p")) {
    const inlines = paragraphInlines(p);
    const bullet = paragraphBullet(p);
    if (bullet === null)
      // an unbulleted paragraph at an open list's margin continues its last item (#196)
      // (in a title placeholder, a paragraph outside the lists is a heading)
      lists.place(paragraphMargin(p), (continued) => [
        asHeaders && !continued
          ? new Header({ level: 1, content: inlines })
          : new Para({ content: inlines }),
      ]);
    else {
      const startAt = bullet === "ordered" ? paragraphStartAt(p) : undefined;
      lists.item(
        {
          kind: bullet,
          level: paragraphLevel(p),
          key: "",
          // an ordered item that restarts its numbering begins a new list (#196)
          restart: startAt !== undefined,
          start: startAt ?? 1,
          indent: paragraphMargin(p),
        },
        new Plain({ content: inlines }),
      );
    }
  }
  return lists.closeAll();
};

/** Placeholder types whose text is the slide's title. */
const TITLE_PLACEHOLDERS = new Set(["title", "ctrTitle"]);

const shapeOf = (sp: XmlElement): Shape => {
  const nvSpPr = findChild(sp, "nvSpPr");
  const nvPr = nvSpPr === undefined ? undefined : findChild(nvSpPr, "nvPr");
  const ph = nvPr === undefined ? undefined : findChild(nvPr, "ph");
  // A <p:ph> without a type is an "obj" placeholder (ST_PlaceholderType default).
  const placeholderType = ph === undefined ? undefined : (getAttr(ph, "type") ?? "obj");
  const txBody = findChild(sp, "txBody");
  const asHeaders = placeholderType !== undefined && TITLE_PLACEHOLDERS.has(placeholderType);
  const content = txBody === undefined ? [] : txBodyToBlocks(txBody, asHeaders);
  if (ph !== undefined) {
    const idxStr = getAttr(ph, "idx");
    return new Placeholder({
      placeholderType: placeholderType!,
      idx: idxStr === undefined ? undefined : Number.parseInt(idxStr, 10),
      content,
    });
  }
  return new TextBox({ content });
};

/**
 * The `<p:sp>` shapes of a shape tree in document order, descending into
 * `<p:grpSp>` groups (with an explicit stack, so deep groups can't overflow).
 */
const shapeElements = (spTree: XmlElement): XmlElement[] => {
  const out: XmlElement[] = [];
  const stack: XmlElement[] = spTree.children.toReversed();
  while (Arr.isReadonlyArrayNonEmpty(stack)) {
    const el = stack.pop()!;
    if (el.name === "sp") out.push(el);
    else if (el.name === "grpSp")
      for (let n = el.children.length - 1; n >= 0; n--) stack.push(el.children[n]!);
  }
  return out;
};

/** Create a PPTX Reader. */
export const makePptxReader = (options?: PptxReaderOptions): Reader<PptxReadFeature> => {
  const read = (input: Content): Effect.Effect<Doc<PptxReadFeature>, ParseError> =>
    Effect.try({
      try: () => {
        const pkg = new OpcReader(contentToBytes(input), options?.limits);
        const presPath = pkg.rootTarget("/officeDocument", "ppt/presentation.xml");
        pkg.expectMainPart(presPath, "pptx", MAIN_CONTENT_TYPES);
        const presXml = pkg.text(presPath);
        if (presXml === null)
          throw new OpcError("MissingPart", `missing presentation part: ${presPath}`);
        const pres = pkg.xml(presPath)!;

        const rels = new Map<string, string>();
        for (const r of pkg.rels(presPath)) rels.set(r.id, r.target);

        const sldIdLst = findChild(pres, "sldIdLst");
        const slideEls = sldIdLst === undefined ? [] : findChildren(sldIdLst, "sldId");

        const slides: Slide[] = [];
        for (const sldId of slideEls) {
          // use the relationship id (r:id), not the numeric slide id attribute
          const rid = getAttr(sldId, "r:id");
          const target = rid === undefined ? undefined : rels.get(rid);
          if (target === undefined)
            throw new OpcError("MissingPart", `cannot resolve slide relationship "${rid}"`);
          const slideXml = pkg.text(target);
          if (slideXml === null) throw new OpcError("MissingPart", `missing slide part: ${target}`);
          const slideRoot = pkg.xml(target)!;
          const cSld = findChild(slideRoot, "cSld");
          const spTree = cSld === undefined ? undefined : findChild(cSld, "spTree");
          const shapes = spTree === undefined ? [] : shapeElements(spTree).map(shapeOf);
          slides.push(new Slide({ shapes }));
        }

        return trustAs<PptxReadFeature>(document([new SlideShow({ slides })]));
      },
      catch: (cause) => ooxmlParseError("pptx", cause),
    });
  return { format: "pptx", profile: PptxRead, read };
};

/** The Context tag for the PPTX reader, so a program can depend on a PPTX reader and have one provided. */
export const PptxReaderTag = makeReaderTag<PptxReadFeature>("pptx");
/** A Layer providing the default PPTX reader for {@link PptxReaderTag}. */
export const PptxReaderLive = Layer.succeed(PptxReaderTag, makePptxReader());
