/**
 * The PPTX Writer: a PPTX-profile document -> .pptx bytes.
 *
 * Renders the document's `SlideShow` (and any loose top-level prose, wrapped in
 * a slide) as PresentationML slides: each shape becomes a `<p:sp>` with a text
 * body of paragraphs/runs. Bundles the constant master/layout/theme parts so
 * the result is a structurally valid deck.
 */

import * as Match from "effect/Match";
import * as Predicate from "effect/Predicate";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  type Block,
  type BlockOf,
  bytes,
  type Content,
  type Doc,
  type Header,
  type Inline,
  type InlineOf,
  isNodeIn,
  makeWriterTag,
  type Para,
  type Plain,
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

/**
 * An inline of the PPTX profile. The table is exhaustive over the profile's
 * inlines, so a feature added to the profile without a rendering here is a
 * compile error (#109).
 */
const pptxInline = (n: InlineOf<PptxFeature>, f: Fmt): string =>
  Match.valueTags(n, {
    Str: (s) => aRun(s.text, f),
    Space: () => aRun(" ", f),
    SoftBreak: () => aRun(" ", f),
    LineBreak: () => "<a:br/>",
    Emph: (m) => inlineRuns(m.content, { ...f, i: true }),
    Strong: (m) => inlineRuns(m.content, { ...f, b: true }),
    Underline: (m) => inlineRuns(m.content, { ...f, u: true }),
    Strikeout: (m) => inlineRuns(m.content, { ...f, strike: true }),
  });

/** Inlines outside the profile (in a document handed over with `trustAs`) are dropped. */
const inlineToRuns = (n: Inline, f: Fmt): string => (isNodeIn(Pptx, n) ? pptxInline(n, f) : "");

/** A paragraph: its bullet element, runs, level and any further `a:pPr` attributes (`marL`, `indent`). */
const aPara = (bullet: string, runs: string, lvl = 0, attrs = ""): string =>
  `<a:p><a:pPr${lvl > 0 ? ` lvl="${lvl}"` : ""}${attrs}>${bullet}</a:pPr>${runs}</a:p>`;

/** The hanging indent of a list paragraph, in EMU (a quarter inch is PowerPoint's default). */
const HANGING = 342900;

/**
 * The left margin of list level `lvl`, in EMU. An item's paragraph hangs its
 * bullet in it, and the item's later paragraphs are written at the same
 * margin without a bullet, as PowerPoint writes them, so the reader can tell
 * them from paragraphs after the list (#196).
 */
const levelMargin = (lvl: number): number => HANGING * (lvl + 1);

/** An item's first block, when it is a paragraph: its bulleted paragraph. */
const isLead = (b: Block | undefined): b is Para | Plain | Header =>
  b !== undefined &&
  (Predicate.isTagged(b, "Para") ||
    Predicate.isTagged(b, "Plain") ||
    Predicate.isTagged(b, "Header"));

const BULLET = '<a:buChar char="&#8226;"/>';
/** An auto-numbered paragraph; the first item of each list says where it starts. */
const autoNum = (startAt: number | undefined): string =>
  `<a:buAutoNum type="arabicPeriod"${startAt === undefined ? "" : ` startAt="${startAt}"`}/>`;
/** DrawingML paragraph levels run 0-8. */
const MAX_LVL = 8;

/**
 * Render a block as paragraphs. Nested lists inside a list item become
 * paragraphs one `lvl` deeper. `inTitle`: the shape is a title placeholder,
 * whose text the reader takes as headers, so headers there need no bold.
 */
const blockToParas = (b: Block, lvl: number, inTitle: boolean): string => {
  if (isNodeIn(Pptx, b)) return pptxBlock(b, lvl, inTitle);
  // Outside the profile, in a document handed over with `trustAs`: a header
  // is a bold paragraph (the reader takes only title-placeholder text as
  // headers); anything else is dropped.
  if (Predicate.isTagged(b, "Header"))
    return aPara("<a:buNone/>", inlineRuns(b.content, inTitle ? {} : { b: true }));
  return "";
};

/**
 * An item's block after its bulleted paragraph: a nested list one `lvl`
 * deeper, or a paragraph at the item's margin without a bullet (#196).
 */
const itemBlock = (b: Block, lvl: number, inTitle: boolean): string =>
  Predicate.isTagged(b, "BulletList") || Predicate.isTagged(b, "OrderedList")
    ? blockToParas(b, Math.min(lvl + 1, MAX_LVL), inTitle)
    : isLead(b)
      ? aPara(
          "<a:buNone/>",
          inlineRuns(b.content, {}),
          lvl,
          ` marL="${levelMargin(lvl)}" indent="0"`,
        )
      : "";

/**
 * A list's items as paragraphs: each item's first paragraph bulleted (empty
 * when the item starts with a list), its other blocks after it. `bullet`
 * gives an item's bullet element from its index.
 */
const listParas = (
  items: ReadonlyArray<ReadonlyArray<Block>>,
  bullet: (index: number) => string,
  lvl: number,
  inTitle: boolean,
): string =>
  items
    .map((it, index) => {
      const [first, ...rest] = it;
      const lead = isLead(first) ? first.content : [];
      const attrs = ` marL="${levelMargin(lvl)}" indent="-${HANGING}"`;
      return (
        aPara(bullet(index), inlineRuns(lead, {}), lvl, attrs) +
        (isLead(first) ? rest : it).map((x) => itemBlock(x, lvl, inTitle)).join("")
      );
    })
    .join("");

/** A block of the PPTX profile; exhaustive over the profile's blocks (#109). */
const pptxBlock = (b: BlockOf<PptxFeature>, lvl: number, inTitle: boolean): string =>
  Match.valueTags(b, {
    Para: (p) => aPara("<a:buNone/>", inlineRuns(p.content, {})),
    Plain: (p) => aPara("<a:buNone/>", inlineRuns(p.content, {})),
    BulletList: (l) => listParas(l.items, () => BULLET, lvl, inTitle),
    // The first item's `startAt` starts a new list, so adjacent ordered lists
    // stay separate (#196), and carries the list's start.
    OrderedList: (l) =>
      listParas(l.items, (i) => autoNum(i === 0 ? (l.start ?? 1) : undefined), lvl, inTitle),
    // a slide show isn't prose: its slides are written as slides
    SlideShow: () => "",
  });

/**
 * The text of a shape of the PPTX profile, exhaustive over the profile's
 * shapes (#109). Pictures and tables, outside it, are written as empty shapes.
 */
const shapeContent = (shape: Shape): ReadonlyArray<Block> =>
  isNodeIn(Pptx, shape)
    ? Match.valueTags(shape, {
        TextBox: (t) => t.content,
        Placeholder: (p) => p.content,
      })
    : [];

const shapeXml = (shape: Shape, idx: number): string => {
  const id = idx + 2; // id 1 is the group shape
  const y = 457200 + idx * 1100000;
  const isPlaceholder = Predicate.isTagged(shape, "Placeholder");
  const ph = isPlaceholder
    ? `<p:ph type="${escapeAttr(shape.placeholderType)}"${shape.idx !== undefined ? ` idx="${shape.idx}"` : ""}/>`
    : "";
  const txBox = Predicate.isTagged(shape, "TextBox") ? ' txBox="1"' : "";
  const content = shapeContent(shape);
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

/** Options for the PPTX writer. */
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

        const files = {
          "[Content_Types].xml": contentTypesXml(slides.length),
          "_rels/.rels": rootRelsXml(),
          "ppt/presentation.xml": presentationXml(slides.length),
          "ppt/_rels/presentation.xml.rels": presentationRelsXml(slides.length),
          "ppt/slideMasters/slideMaster1.xml": slideMasterXml(),
          "ppt/slideMasters/_rels/slideMaster1.xml.rels": slideMasterRelsXml(),
          "ppt/slideLayouts/slideLayout1.xml": slideLayoutXml(),
          "ppt/slideLayouts/_rels/slideLayout1.xml.rels": slideLayoutRelsXml(),
          "ppt/theme/theme1.xml": themeXml(),
          ...Object.fromEntries(
            slides.flatMap((slide, i) => [
              [`ppt/slides/slide${i + 1}.xml`, slideXml(slide)],
              [`ppt/slides/_rels/slide${i + 1}.xml.rels`, slideRelsXml()],
            ]),
          ),
        };

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

/** The Context tag for the PPTX writer, so a program can depend on a PPTX writer and have one provided. */
export const PptxWriterTag = makeWriterTag<PptxFeature>("pptx");
/** A Layer providing the default PPTX writer for {@link PptxWriterTag}. */
export const PptxWriterLive = Layer.succeed(PptxWriterTag, makePptxWriter());
