/**
 * The PPTX Writer: a PPTX-profile document -> .pptx bytes.
 *
 * Renders the document's `SlideShow` (and any loose top-level prose, wrapped in
 * a slide) as PresentationML slides: each shape becomes a `<p:sp>` with a text
 * body of paragraphs/runs. Bundles the constant master/layout/theme parts so
 * the result is a structurally valid deck.
 */

import * as Predicate from "effect/Predicate";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  type Block,
  bytes,
  type Content,
  type Doc,
  type Inline,
  makeWriterTag,
  type Shape,
  Slide,
  TextBox,
  WriteError,
  type Writer,
} from "@thomasfosterau/effect-document";
import {
  NS_PKG_REL,
  NS_REL_DOC,
  XML_DECL,
  escapeAttr,
  escapeXml,
  zipParts,
} from "../shared/index.ts";
import {
  NS_A,
  NS_P,
  REL_SLIDE,
  REL_SLIDE_MASTER,
  contentTypesXml,
  rootRelsXml,
  slideLayoutRelsXml,
  slideLayoutXml,
  slideMasterRelsXml,
  slideMasterXml,
  slideRelsXml,
  themeXml,
} from "./parts.ts";
import { Pptx, type PptxFeature } from "./profile.ts";

interface Fmt {
  b?: boolean | undefined;
  i?: boolean | undefined;
  u?: boolean | undefined;
  strike?: boolean | undefined;
}

const aRun = (text: string, f: Fmt): string =>
  `<a:r><a:rPr lang="en-US"${f.b ? ' b="1"' : ""}${f.i ? ' i="1"' : ""}${f.u ? ' u="sng"' : ""}${f.strike ? ' strike="sngStrike"' : ""}/><a:t>${escapeXml(text)}</a:t></a:r>`;

const inlineRuns = (ns: ReadonlyArray<Inline>, f: Fmt): string =>
  ns.map((n) => inlineToRuns(n, f)).join("");

const inlineToRuns = (n: Inline, f: Fmt): string => {
  if (Predicate.isTagged(n, "Str")) {
    return aRun(n.text, f);
  } else if (Predicate.isTagged(n, "Space") || Predicate.isTagged(n, "SoftBreak")) {
    return aRun(" ", f);
  } else if (Predicate.isTagged(n, "LineBreak")) {
    return "<a:br/>";
  } else if (Predicate.isTagged(n, "Emph")) {
    return inlineRuns(n.content, { ...f, i: true });
  } else if (Predicate.isTagged(n, "Strong")) {
    return inlineRuns(n.content, { ...f, b: true });
  } else if (Predicate.isTagged(n, "Underline")) {
    return inlineRuns(n.content, { ...f, u: true });
  } else if (Predicate.isTagged(n, "Strikeout")) {
    return inlineRuns(n.content, { ...f, strike: true });
  } else {
    return "";
  }
};

const aPara = (bullet: string, runs: string, lvl = 0): string =>
  `<a:p><a:pPr${lvl > 0 ? ` lvl="${lvl}"` : ""}>${bullet}</a:pPr>${runs}</a:p>`;

const itemInlines = (blocks: ReadonlyArray<Block>): Inline[] =>
  blocks.flatMap((b) =>
    Predicate.isTagged(b, "Para") ||
    Predicate.isTagged(b, "Plain") ||
    Predicate.isTagged(b, "Header")
      ? [...b.content]
      : [],
  );

const BULLET = '<a:buChar char="&#8226;"/>';
const AUTO_NUM = '<a:buAutoNum type="arabicPeriod"/>';
/** DrawingML paragraph levels run 0-8. */
const MAX_LVL = 8;

/**
 * Render a block as paragraphs. Nested lists inside a list item become
 * paragraphs one `lvl` deeper. `inTitle`: the shape is a title placeholder,
 * whose text the reader takes as headers, so headers there need no bold.
 */
const blockToParas = (b: Block, lvl: number, inTitle: boolean): string => {
  switch (b._tag) {
    case "Para":
    case "Plain":
      return aPara("<a:buNone/>", inlineRuns(b.content, {}));
    case "Header":
      return aPara("<a:buNone/>", inlineRuns(b.content, inTitle ? {} : { b: true }));
    case "BulletList":
    case "OrderedList": {
      const bullet = Predicate.isTagged(b, "BulletList") ? BULLET : AUTO_NUM;
      return b.items
        .map(
          (it) =>
            aPara(bullet, inlineRuns(itemInlines(it), {}), lvl) +
            it
              .filter(
                (x) => Predicate.isTagged(x, "BulletList") || Predicate.isTagged(x, "OrderedList"),
              )
              .map((x) => blockToParas(x, Math.min(lvl + 1, MAX_LVL), inTitle))
              .join(""),
        )
        .join("");
    }
    default:
      return "";
  }
};

const shapeXml = (shape: Shape, idx: number): string => {
  const id = idx + 2; // id 1 is the group shape
  const y = 457200 + idx * 1100000;
  const isPlaceholder = Predicate.isTagged(shape, "Placeholder");
  const ph = isPlaceholder
    ? `<p:ph type="${escapeAttr(shape.placeholderType)}"${shape.idx !== undefined ? ` idx="${shape.idx}"` : ""}/>`
    : "";
  const txBox = Predicate.isTagged(shape, "TextBox") ? ' txBox="1"' : "";
  const content = Predicate.isTagged(shape, "Picture")
    ? []
    : Predicate.isTagged(shape, "TableShape")
      ? []
      : shape.content;
  const inTitle =
    isPlaceholder && (shape.placeholderType === "title" || shape.placeholderType === "ctrTitle");
  const paras =
    content.map((b) => blockToParas(b, 0, inTitle)).join("") ||
    "<a:p><a:pPr><a:buNone/></a:pPr></a:p>";
  return (
    `<p:sp>` +
    `<p:nvSpPr><p:cNvPr id="${id}" name="Shape ${id}"/><p:cNvSpPr${txBox}/><p:nvPr>${ph}</p:nvPr></p:nvSpPr>` +
    `<p:spPr><a:xfrm><a:off x="457200" y="${y}"/><a:ext cx="8229600" cy="1000000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>` +
    `<p:txBody><a:bodyPr/><a:lstStyle/>${paras}</p:txBody>` +
    `</p:sp>`
  );
};

const slideXml = (slide: Slide): string =>
  XML_DECL +
  `<p:sld xmlns:p="${NS_P}" xmlns:r="${NS_REL_DOC}" xmlns:a="${NS_A}">` +
  `<p:cSld><p:spTree>` +
  `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>` +
  slide.shapes.map((sp, i) => shapeXml(sp, i)).join("") +
  `</p:spTree></p:cSld>` +
  `<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>` +
  `</p:sld>`;

const presentationXml = (slideCount: number): string =>
  XML_DECL +
  `<p:presentation xmlns:p="${NS_P}" xmlns:r="${NS_REL_DOC}" xmlns:a="${NS_A}">` +
  `<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rIdMaster"/></p:sldMasterIdLst>` +
  `<p:sldIdLst>` +
  Array.from(
    { length: slideCount },
    (_, i) => `<p:sldId id="${256 + i}" r:id="rIdSlide${i + 1}"/>`,
  ).join("") +
  `</p:sldIdLst>` +
  `<p:sldSz cx="9144000" cy="6858000" type="screen4x3"/><p:notesSz cx="6858000" cy="9144000"/>` +
  `</p:presentation>`;

const presentationRelsXml = (slideCount: number): string =>
  XML_DECL +
  `<Relationships xmlns="${NS_PKG_REL}">` +
  `<Relationship Id="rIdMaster" Type="${REL_SLIDE_MASTER}" Target="slideMasters/slideMaster1.xml"/>` +
  Array.from(
    { length: slideCount },
    (_, i) =>
      `<Relationship Id="rIdSlide${i + 1}" Type="${REL_SLIDE}" Target="slides/slide${i + 1}.xml"/>`,
  ).join("") +
  `</Relationships>`;

export interface PptxWriterOptions {
  readonly compressionLevel?: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | undefined;
}

/** Create a PPTX Writer. */
export const makePptxWriter = (options?: PptxWriterOptions): Writer<PptxFeature> => {
  const level = options?.compressionLevel ?? 6;
  const write = (doc: Doc<PptxFeature>): Effect.Effect<Content, WriteError> =>
    Effect.try({
      try: () => {
        // Collect slides from any SlideShow blocks; wrap loose prose in a slide.
        const slides: Slide[] = [];
        const loose: Block[] = [];
        for (const b of doc.blocks) {
          if (Predicate.isTagged(b, "SlideShow")) slides.push(...b.slides);
          else loose.push(b);
        }
        if (Arr.isReadonlyArrayNonEmpty(loose))
          slides.push(new Slide({ shapes: [new TextBox({ content: loose })] }));
        if (Arr.isReadonlyArrayEmpty(slides)) slides.push(new Slide({ shapes: [] }));

        const files: Record<string, string> = {
          "[Content_Types].xml": contentTypesXml(slides.length),
          "_rels/.rels": rootRelsXml(),
          "ppt/presentation.xml": presentationXml(slides.length),
          "ppt/_rels/presentation.xml.rels": presentationRelsXml(slides.length),
          "ppt/slideMasters/slideMaster1.xml": slideMasterXml(),
          "ppt/slideMasters/_rels/slideMaster1.xml.rels": slideMasterRelsXml(),
          "ppt/slideLayouts/slideLayout1.xml": slideLayoutXml(),
          "ppt/slideLayouts/_rels/slideLayout1.xml.rels": slideLayoutRelsXml(),
          "ppt/theme/theme1.xml": themeXml(),
        };
        slides.forEach((slide, i) => {
          files[`ppt/slides/slide${i + 1}.xml`] = slideXml(slide);
          files[`ppt/slides/_rels/slide${i + 1}.xml.rels`] = slideRelsXml();
        });

        return bytes(zipParts(files, level));
      },
      catch: (cause) =>
        new WriteError({
          format: "pptx",
          reason: `Failed to generate pptx: ${String(cause)}`,
          cause,
        }),
    });
  return { format: "pptx", profile: Pptx, write };
};

export const PptxWriterTag = makeWriterTag<PptxFeature>("pptx");
export const PptxWriterLive = Layer.succeed(PptxWriterTag, makePptxWriter());
