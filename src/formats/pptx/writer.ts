/**
 * The PPTX Writer: a PPTX-profile document -> .pptx bytes.
 *
 * Renders the document's `SlideShow` (and any loose top-level prose, wrapped in
 * a slide) as PresentationML slides: each shape becomes a `<p:sp>` with a text
 * body of paragraphs/runs. Bundles the constant master/layout/theme parts so
 * the result is a structurally valid deck.
 */

import { Effect, Layer } from "effect";
import { type Doc } from "../../profile/profile.js";
import {
  type Block, type Inline, type Shape, Slide, TextBox,
} from "../../schema/index.js";
import { bytes, type Content } from "../../io/content.js";
import { WriteError } from "../../io/errors.js";
import { makeWriterTag, type Writer } from "../../io/writer.js";
import { NS_PKG_REL, NS_REL_DOC, XML_DECL, escapeAttr, escapeXml, zipParts } from "../ooxml/index.js";
import {
  NS_A, NS_P, REL_SLIDE, REL_SLIDE_MASTER, contentTypesXml, rootRelsXml,
  slideLayoutRelsXml, slideLayoutXml, slideMasterRelsXml, slideMasterXml,
  slideRelsXml, themeXml,
} from "./parts.js";
import { Pptx, type PptxFeature } from "./profile.js";

interface Fmt {
  b?: boolean;
  i?: boolean;
  u?: boolean;
  strike?: boolean;
}

const aRun = (text: string, f: Fmt): string =>
  `<a:r><a:rPr lang="en-US"${f.b ? ' b="1"' : ""}${f.i ? ' i="1"' : ""}${f.u ? ' u="sng"' : ""}${f.strike ? ' strike="sngStrike"' : ""}/><a:t>${escapeXml(text)}</a:t></a:r>`;

const inlineRuns = (ns: ReadonlyArray<Inline>, f: Fmt): string =>
  ns.map((n) => inlineToRuns(n, f)).join("");

const inlineToRuns = (n: Inline, f: Fmt): string => {
  switch (n._tag) {
    case "Str": return aRun(n.text, f);
    case "Space": case "SoftBreak": return aRun(" ", f);
    case "LineBreak": return "<a:br/>";
    case "Emph": return inlineRuns(n.content, { ...f, i: true });
    case "Strong": return inlineRuns(n.content, { ...f, b: true });
    case "Underline": return inlineRuns(n.content, { ...f, u: true });
    case "Strikeout": return inlineRuns(n.content, { ...f, strike: true });
    default: return "";
  }
};

const aPara = (bullet: string, runs: string): string =>
  `<a:p><a:pPr>${bullet}</a:pPr>${runs}</a:p>`;

const itemInlines = (blocks: ReadonlyArray<Block>): Inline[] =>
  blocks.flatMap((b) =>
    b._tag === "Para" || b._tag === "Plain" || b._tag === "Header" ? [...b.content] : []
  );

const blockToParas = (b: Block): string => {
  switch (b._tag) {
    case "Para": case "Plain":
      return aPara("<a:buNone/>", inlineRuns(b.content, {}));
    case "Header":
      return aPara("<a:buNone/>", inlineRuns(b.content, { b: true }));
    case "BulletList":
      return b.items.map((it) => aPara('<a:buChar char="&#8226;"/>', inlineRuns(itemInlines(it), {}))).join("");
    case "OrderedList":
      return b.items.map((it) => aPara('<a:buAutoNum type="arabicPeriod"/>', inlineRuns(itemInlines(it), {}))).join("");
    default:
      return "";
  }
};

const shapeXml = (shape: Shape, idx: number): string => {
  const id = idx + 2; // id 1 is the group shape
  const y = 457200 + idx * 1100000;
  const isPlaceholder = shape._tag === "Placeholder";
  const ph = isPlaceholder
    ? `<p:ph type="${escapeAttr(shape.placeholderType)}"${shape.idx !== undefined ? ` idx="${shape.idx}"` : ""}/>`
    : "";
  const txBox = shape._tag === "TextBox" ? ' txBox="1"' : "";
  const content = shape._tag === "Picture" ? [] : shape._tag === "TableShape" ? [] : shape.content;
  const paras = content.map(blockToParas).join("") || '<a:p><a:pPr><a:buNone/></a:pPr></a:p>';
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
  Array.from({ length: slideCount }, (_, i) => `<p:sldId id="${256 + i}" r:id="rIdSlide${i + 1}"/>`).join("") +
  `</p:sldIdLst>` +
  `<p:sldSz cx="9144000" cy="6858000" type="screen4x3"/><p:notesSz cx="6858000" cy="9144000"/>` +
  `</p:presentation>`;

const presentationRelsXml = (slideCount: number): string =>
  XML_DECL +
  `<Relationships xmlns="${NS_PKG_REL}">` +
  `<Relationship Id="rIdMaster" Type="${REL_SLIDE_MASTER}" Target="slideMasters/slideMaster1.xml"/>` +
  Array.from(
    { length: slideCount },
    (_, i) => `<Relationship Id="rIdSlide${i + 1}" Type="${REL_SLIDE}" Target="slides/slide${i + 1}.xml"/>`
  ).join("") +
  `</Relationships>`;

export interface PptxWriterOptions {
  readonly compressionLevel?: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
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
          if (b._tag === "SlideShow") slides.push(...b.slides);
          else loose.push(b);
        }
        if (loose.length > 0) slides.push(new Slide({ shapes: [new TextBox({ content: loose })] }));
        if (slides.length === 0) slides.push(new Slide({ shapes: [] }));

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
        new WriteError({ format: "pptx", reason: `Failed to generate pptx: ${String(cause)}`, cause }),
    });
  return { format: "pptx", profile: Pptx, write };
};

export const PptxWriterTag = makeWriterTag<PptxFeature>("pptx");
export const PptxWriterLive = Layer.succeed(PptxWriterTag, makePptxWriter());
