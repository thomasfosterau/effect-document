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
 *
 * Bullets, margins and run marks a paragraph does not state are inherited
 * (#82, `inheritance.ts`): from the shape's own list style, its layout and
 * master placeholders, the master's text styles and the presentation's
 * defaults. A slide's `layout` is its layout part's name.
 */

import { sniffOpc } from "../shared/sniff.ts";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
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
  logDiagnostics,
  makeReaderTag,
  Para,
  ParseError,
  Placeholder,
  Plain,
  type Reader,
  type Shape,
  Slide,
  SlideShow,
  str,
  Strikeout,
  Strong,
  TextBox,
  trustAs,
  Underline,
  type Sniffer,
} from "../../index.ts";
import {
  OpcError,
  type OpcLimits,
  OpcReader,
  readPackageMeta,
  relsPartOf,
  type XmlElement,
  findChild,
  findChildren,
  getAttr,
  type ListEntry,
  ListStack,
  ooxmlParseError,
} from "../shared/index.ts";
import {
  buOf,
  EMPTY_LEVEL,
  type Fmt,
  Inheritance,
  intAttr,
  type ResolvedLevel,
  type ResolvedLevels,
  shapeElements,
  type SlideStyles,
} from "./inheritance.ts";
import { PptxRead, type PptxReadFeature, TITLE_PLACEHOLDER_TYPES } from "./profile.ts";

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

const wrap = (node: Inline, f: Fmt): Inline => {
  let x = node;
  if (f.i) x = new Emph({ content: [x] });
  if (f.b) x = new Strong({ content: [x] });
  if (f.u) x = new Underline({ content: [x] });
  if (f.strike) x = new Strikeout({ content: [x] });
  return x;
};

/** An `xsd:boolean` attribute: "true"/"1" or "false"/"0". */
const isTrue = (v: string): boolean => v === "1" || v === "true";

/** A run's marks: its own `a:rPr` attributes, then the level's (`base`) for any it does not set. */
const runFmt = (r: XmlElement, base: Fmt): Fmt => {
  const rPr = findChild(r, "rPr");
  if (rPr === undefined) return base;
  const b = getAttr(rPr, "b");
  const i = getAttr(rPr, "i");
  const u = getAttr(rPr, "u");
  const strike = getAttr(rPr, "strike");
  if (b === undefined && i === undefined && u === undefined && strike === undefined) return base;
  return {
    b: b === undefined ? base.b : isTrue(b),
    i: i === undefined ? base.i : isTrue(i),
    u: u === undefined ? base.u : u !== "none",
    strike: strike === undefined ? base.strike : strike !== "noStrike",
  };
};

const paragraphInlines = (p: XmlElement, base: Fmt): Inline[] => {
  const out: Inline[] = [];
  for (const child of p.children) {
    // Fields (slide numbers, dates) carry their current text like a run.
    if (child.name === "r" || child.name === "fld") {
      const t = findChild(child, "t");
      if (t !== undefined) out.push(wrap(str(t.text), runFmt(child, base)));
    } else if (child.name === "br") {
      out.push(new LineBreak());
    }
  }
  return out;
};

const ZERO = () => 0;
const ONE = () => 1;

/** The paragraph's indent level, `a:pPr@lvl` (0-8). */
const paragraphLevel = (pPr?: XmlElement): number =>
  Math.min(Math.max(Option.getOrElse(intAttr("lvl", pPr), ZERO), 0), 8);

/** A paragraph that starts a list item. */
interface Item extends ListEntry {
  /** Whether the paragraph is no item after all. */
  readonly skip: boolean;
}

/** The list item a paragraph is, or `None` when it is not one. */
const itemOf = (
  level: ResolvedLevel,
  lvl: number,
  marL: Option.Option<number>,
  empty: boolean,
  pPr?: XmlElement,
): Option.Option<Item> => {
  const own = buOf(pPr);
  const bu = Option.isSome(own) ? own : level.bu;
  if (Option.isNone(bu) || bu.value.kind === "none") return Option.none();
  const ordered = bu.value.kind === "ordered";
  return Option.some({
    kind: ordered ? "ordered" : "bullet",
    level: lvl,
    key: "",
    // an ordered item that says where it restarts begins a new list (#196);
    // a start inherited from a list style only starts the list
    restart: ordered && Option.isSome(own) && Option.isSome(own.value.startAt),
    start: ordered ? Option.getOrElse(bu.value.startAt, ONE) : 1,
    indent: Option.getOrUndefined(marL),
    // an empty paragraph that only inherits its bullet shows none, so it is no item
    skip: Option.isNone(own) && empty,
  });
};

/**
 * A shape's paragraphs as blocks. `levels` is the shape's resolved list style
 * (see `inheritance.ts`): a paragraph's own bullet, margin and marks win, and
 * what it does not say comes from its level.
 */
const txBodyToBlocks = (
  txBody: XmlElement,
  asHeaders: boolean,
  levels: ResolvedLevels,
): Block[] => {
  const lists = new ListStack();
  findChildren(txBody, "p").forEach((p) => {
    const pPr = findChild(p, "pPr");
    const lvl = paragraphLevel(pPr);
    const level = levels[lvl] ?? EMPTY_LEVEL;
    const inlines = paragraphInlines(p, level.fmt);
    const own = intAttr("marL", pPr);
    const marL = Option.isSome(own) ? own : level.marL;
    const item = itemOf(level, lvl, marL, Arr.isReadonlyArrayEmpty(inlines), pPr);
    if (Option.isNone(item))
      // an unbulleted paragraph at an open list's margin continues its last item (#196)
      // (in a title placeholder, a paragraph outside the lists is a heading)
      lists.place(Option.getOrUndefined(marL), (continued) => [
        asHeaders && !continued
          ? new Header({ level: 1, content: inlines })
          : new Para({ content: inlines }),
      ]);
    else if (!item.value.skip) lists.item(item.value, new Plain({ content: inlines }));
  });
  return lists.closeAll();
};

const shapeOf = (sp: XmlElement, styles: SlideStyles): Shape => {
  const nvSpPr = findChild(sp, "nvSpPr");
  const nvPr = nvSpPr === undefined ? undefined : findChild(nvSpPr, "nvPr");
  const ph = nvPr === undefined ? undefined : findChild(nvPr, "ph");
  // A <p:ph> without a type is an "obj" placeholder (ST_PlaceholderType default).
  const type = ph === undefined ? Option.none() : Option.some(getAttr(ph, "type") ?? "obj");
  const idx = intAttr("idx", ph);
  const txBody = findChild(sp, "txBody");
  const asHeaders = Option.exists(type, (t) => TITLE_PLACEHOLDER_TYPES.includes(t));
  const lstStyle = txBody === undefined ? undefined : findChild(txBody, "lstStyle");
  const content =
    txBody === undefined
      ? []
      : txBodyToBlocks(
          txBody,
          asHeaders,
          styles.levelsFor(type, idx, Option.fromUndefinedOr(lstStyle)),
        );
  return Option.match(type, {
    onNone: () => new TextBox({ content }),
    onSome: (placeholderType) =>
      new Placeholder({ placeholderType, idx: Option.getOrUndefined(idx), content }),
  });
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

        // inflate every slide and its relationships in one pass over the zip directory
        pkg.prefetch(
          slideEls.flatMap((sldId) => {
            const rid = getAttr(sldId, "r:id");
            const target = rid === undefined ? undefined : rels.get(rid);
            return target === undefined ? [] : [target, relsPartOf(target)];
          }),
        );
        const inheritance = new Inheritance(pkg, pres);
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
          const styles = inheritance.forSlide(target);
          const shapes =
            spTree === undefined ? [] : shapeElements(spTree).map((sp) => shapeOf(sp, styles));
          slides.push(new Slide({ shapes, layout: Option.getOrUndefined(styles.layoutName) }));
        }

        const { meta, diagnostics } = readPackageMeta(pkg, "pptx");
        return {
          doc: trustAs<PptxReadFeature>(document([new SlideShow({ slides })], meta)),
          diagnostics: [...inheritance.diagnostics, ...diagnostics],
        };
      },
      catch: (cause) => ooxmlParseError("pptx", cause),
    }).pipe(Effect.flatMap(({ doc, diagnostics }) => Effect.as(logDiagnostics(diagnostics), doc)));
  return { format: "pptx", profile: PptxRead, read };
};

/** The Context tag for the PPTX reader, so a program can depend on a PPTX reader and have one provided. */
export const PptxReaderTag = makeReaderTag<PptxReadFeature>("pptx");
/** A Layer providing the default PPTX reader for {@link PptxReaderTag}. */
export const PptxReaderLive = Layer.succeed(PptxReaderTag, makePptxReader());

/**
 * The PPTX sniffer, for `detect` (#188): a zip whose main part (found as
 * the reader finds it) is declared a PresentationML main part, which is what
 * the reader requires.
 */
export const sniffPptx: Sniffer = (content) =>
  sniffOpc(content, {
    name: "PresentationML",
    fallback: "ppt/presentation.xml",
    contentTypes: MAIN_CONTENT_TYPES,
  });
