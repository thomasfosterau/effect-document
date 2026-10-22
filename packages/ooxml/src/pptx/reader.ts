/**
 * The PPTX Reader: .pptx bytes -> a presentation document in the PPTX profile.
 *
 * Walks `ppt/presentation.xml` for the ordered slide list, then each slide's
 * shape tree: every `<p:sp>` becomes a TextBox (or a Placeholder, if it carries
 * a `<p:ph>`), whose text body is read back into paragraphs/lists with
 * bold/italic/underline/strike runs.
 */

import { Effect, Layer } from "effect";
import {
  type Block, BulletList, type Content, contentToBytes, type Doc, document, Emph, type Inline,
  LineBreak, makeReaderTag, OrderedList, Para, ParseError, Placeholder, Plain, type Reader,
  type Shape, Slide, SlideShow, Str, Strikeout, Strong, TextBox, trustAs, Underline,
} from "@thomasfosterau/effect-document";
import {
  type OpcLimits, OpcReader, type XmlElement, findChild, findChildren, getAttr, ooxmlParseError,
} from "../shared/index.js";
import { Pptx, type PptxFeature } from "./profile.js";

export interface PptxReaderOptions {
  /** Zip resource limits (entry count, inflated bytes); see `OpcLimits`. */
  readonly limits?: Partial<OpcLimits>;
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

const runFmt = (r: XmlElement): Fmt => {
  const rPr = findChild(r, "rPr");
  const attr = (name: string): string | undefined => (rPr === undefined ? undefined : getAttr(rPr, name));
  return {
    b: attr("b") === "1",
    i: attr("i") === "1",
    u: attr("u") !== undefined && attr("u") !== "none",
    strike: attr("strike") !== undefined && attr("strike") !== "noStrike",
  };
};

const paragraphInlines = (p: XmlElement): Inline[] => {
  const out: Inline[] = [];
  for (const child of p.children) {
    if (child.name === "r") {
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

const txBodyToBlocks = (txBody: XmlElement): Block[] => {
  const out: Block[] = [];
  let listItems: Block[][] = [];
  let listKind: "bullet" | "ordered" | null = null;

  const flushList = (): void => {
    if (listKind === null || listItems.length === 0) return;
    out.push(
      listKind === "ordered"
        ? new OrderedList({ items: listItems })
        : new BulletList({ items: listItems })
    );
    listItems = [];
    listKind = null;
  };

  for (const p of findChildren(txBody, "p")) {
    const inlines = paragraphInlines(p);
    const bullet = paragraphBullet(p);
    if (bullet !== null) {
      if (listKind !== null && listKind !== bullet) flushList();
      listKind = bullet;
      listItems.push([new Plain({ content: inlines })]);
    } else {
      flushList();
      out.push(new Para({ content: inlines }));
    }
  }
  flushList();
  return out;
};

const shapeOf = (sp: XmlElement): Shape => {
  const txBody = findChild(sp, "txBody");
  const content = txBody === undefined ? [] : txBodyToBlocks(txBody);
  const nvSpPr = findChild(sp, "nvSpPr");
  const nvPr = nvSpPr === undefined ? undefined : findChild(nvSpPr, "nvPr");
  const ph = nvPr === undefined ? undefined : findChild(nvPr, "ph");
  if (ph !== undefined) {
    const idxStr = getAttr(ph, "idx");
    return new Placeholder({
      placeholderType: getAttr(ph, "type") ?? "body",
      idx: idxStr === undefined ? undefined : Number.parseInt(idxStr, 10),
      content,
    });
  }
  return new TextBox({ content });
};

/** Create a PPTX Reader. */
export const makePptxReader = (options?: PptxReaderOptions): Reader<PptxFeature> => {
  const read = (input: Content): Effect.Effect<Doc<PptxFeature>, ParseError> =>
    Effect.try({
      try: () => {
        const pkg = new OpcReader(contentToBytes(input), options?.limits);
        const presPath = pkg.rootTarget("/officeDocument", "ppt/presentation.xml");
        pkg.expectMainPart(presPath, "pptx", MAIN_CONTENT_TYPES);
        const presXml = pkg.text(presPath);
        if (presXml === null) throw new Error(`missing presentation part: ${presPath}`);
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
          if (target === undefined) continue;
          const slideXml = pkg.text(target);
          if (slideXml === null) continue;
          const slideRoot = pkg.xml(target)!;
          const cSld = findChild(slideRoot, "cSld");
          const spTree = cSld === undefined ? undefined : findChild(cSld, "spTree");
          const shapes = spTree === undefined ? [] : findChildren(spTree, "sp").map(shapeOf);
          slides.push(new Slide({ shapes }));
        }

        return trustAs<PptxFeature>(document([new SlideShow({ slides })]));
      },
      catch: (cause) =>
        ooxmlParseError("pptx", cause),
    });
  return { format: "pptx", profile: Pptx, read };
};

export const PptxReaderTag = makeReaderTag<PptxFeature>("pptx");
export const PptxReaderLive = Layer.succeed(PptxReaderTag, makePptxReader());
