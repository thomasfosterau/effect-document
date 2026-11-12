/**
 * PPTX style inheritance (#82): bullets, margins and run marks a shape takes
 * from its layout, its master and the presentation instead of its paragraphs.
 */

import { it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { assert, describe, expect } from "vite-plus/test";
import {
  type Block,
  blocksToText,
  bytes,
  collectDiagnostics,
  type Content,
  document,
  type Inline,
  slide,
  slideShow,
  trustAs,
} from "@thomasfosterau/effect-document";
import { makePptxReader, makePptxWriter, type PptxFeature } from "../../../src/ooxml/pptx/index.ts";

const NS = `xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"`;

/** A shape holding `paras`, with `ph` in its `nvPr` and `lst` as its list style. */
const sp = (paras: string, ph = "", lst = "") =>
  `<p:sp><p:nvSpPr><p:cNvPr id="2" name="s"/><p:cNvSpPr/><p:nvPr>${ph}</p:nvPr></p:nvSpPr>` +
  `<p:spPr/><p:txBody><a:bodyPr/>${lst}${paras}</p:txBody></p:sp>`;
/** A paragraph of one run; `lvl` and `rPr` are optional. */
const para = (text: string, lvl?: number, rPr = "") =>
  `<a:p>${lvl === undefined ? "" : `<a:pPr lvl="${lvl}"/>`}<a:r>${rPr === "" ? "" : `<a:rPr ${rPr}/>`}<a:t>${text}</a:t></a:r></a:p>`;
/** A shape tree. */
const tree = (...shapes: string[]) =>
  `<p:spTree><p:nvGrpSpPr/><p:grpSpPr/>${shapes.join("")}</p:spTree>`;

const BULLET = `<a:buChar char="-"/>`;
const NUMBERED = (startAt?: number) =>
  `<a:buAutoNum type="arabicPeriod"${startAt === undefined ? "" : ` startAt="${startAt}"`}/>`;
/** A list style whose `lvl` (1-9) has `inner`, e.g. a bullet, and `marL`. */
const lvl = (n: number, inner: string, attrs = "") =>
  `<a:lvl${n}pPr marL="${n * 300000}" ${attrs}>${inner}</a:lvl${n}pPr>`;
const lst = (...levels: string[]) => `<a:lstStyle>${levels.join("")}</a:lstStyle>`;

const master = (opts: { txStyles?: string; shapes?: string[] }) =>
  `<p:sldMaster ${NS}><p:cSld>${tree(...(opts.shapes ?? []))}</p:cSld>` +
  `<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>` +
  `<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>` +
  `${opts.txStyles === undefined ? "" : `<p:txStyles>${opts.txStyles}</p:txStyles>`}</p:sldMaster>`;
const layout = (name: string, ...shapes: string[]) =>
  `<p:sldLayout ${NS} type="obj"><p:cSld name="${name}">${tree(...shapes)}</p:cSld></p:sldLayout>`;
const txStyles = (parts: { title?: string; body?: string; other?: string }) =>
  `<p:titleStyle>${parts.title ?? ""}</p:titleStyle><p:bodyStyle>${parts.body ?? ""}</p:bodyStyle><p:otherStyle>${parts.other ?? ""}</p:otherStyle>`;

interface Parts {
  readonly slide: string;
  readonly layout?: string;
  readonly master?: string;
  readonly presentation?: (xml: string) => string;
  readonly edit?: (files: Record<string, Uint8Array>) => void;
}

/** A part of an unzipped package as text, empty when absent. */
const partText = (files: Record<string, Uint8Array>, path: string): string =>
  strFromU8(files[path] ?? new Uint8Array());

/** A writer-made deck with its slide, layout, master (and presentation) parts replaced. */
const deckOf = ({ slide: s, layout: l, master: m, presentation, edit }: Parts) =>
  Effect.gen(function* () {
    const out = yield* makePptxWriter().write(
      trustAs<PptxFeature>(document([slideShow([slide([])])])),
    );
    assert(Predicate.isTagged(out, "Bytes"), "expected bytes");
    const files = unzipSync(out.bytes);
    files["ppt/slides/slide1.xml"] = strToU8(`<p:sld ${NS}><p:cSld>${s}</p:cSld></p:sld>`);
    if (l !== undefined) files["ppt/slideLayouts/slideLayout1.xml"] = strToU8(l);
    if (m !== undefined) files["ppt/slideMasters/slideMaster1.xml"] = strToU8(m);
    if (presentation !== undefined)
      files["ppt/presentation.xml"] = strToU8(
        presentation(partText(files, "ppt/presentation.xml")),
      );
    edit?.(files);
    return bytes(zipSync(files));
  });

/** The first slide and the blocks of its shapes in `content`. */
const read = (content: Content) =>
  Effect.gen(function* () {
    const doc = yield* makePptxReader().read(content);
    const deck = doc.blocks.find((b) => Predicate.isTagged(b, "SlideShow"));
    assert(deck !== undefined, "expected a slide show");
    const first = yield* Effect.fromOption(Arr.head(deck.slides));
    return {
      layout: first.layout,
      shapes: first.shapes.map((sh): ReadonlyArray<Block> =>
        Predicate.isTagged(sh, "TextBox") || Predicate.isTagged(sh, "Placeholder")
          ? sh.content
          : [],
      ),
    };
  });

/** A block's shape as a compact string: `P:a`, `H:a`, `UL[a|b]`, `OL3[a|b]`, nested lists in `(…)`. */
const show = (b: Block): string => {
  if (Predicate.isTagged(b, "Para")) return `P:${blocksToText([b]).trim()}`;
  if (Predicate.isTagged(b, "Header")) return `H:${blocksToText([b]).trim()}`;
  if (Predicate.isTagged(b, "BulletList") || Predicate.isTagged(b, "OrderedList")) {
    const head = Predicate.isTagged(b, "BulletList") ? "UL" : `OL${b.start ?? ""}`;
    return `${head}[${b.items.map((item) => item.map((x) => (Predicate.isTagged(x, "Plain") ? blocksToText([x]).trim() : `(${show(x)})`)).join("")).join("|")}]`;
  }
  return b._tag;
};
const showAll = (blocks: ReadonlyArray<Block>) => blocks.map(show);

/** The first shape of the first slide of a deck, shown. */
const firstShape = (parts: Parts) =>
  Effect.gen(function* () {
    const { shapes } = yield* read(yield* deckOf(parts));
    return showAll(shapes[0] ?? []);
  });

/** The nesting of marks around a run's text, outermost first. */
const marks = (i?: Inline): ReadonlyArray<string> =>
  i !== undefined &&
  (Predicate.isTagged(i, "Strong") ||
    Predicate.isTagged(i, "Emph") ||
    Predicate.isTagged(i, "Underline") ||
    Predicate.isTagged(i, "Strikeout"))
    ? [i._tag, ...marks(i.content[0])]
    : [];

const BODY_PH = `<p:ph idx="1"/>`;

describe("PPTX inheritance (#82)", () => {
  it.effect("a body placeholder takes its bullets from the master's bodyStyle", () =>
    Effect.gen(function* () {
      const shown = yield* firstShape({
        slide: tree(sp(para("a") + para("b"), BODY_PH)),
        master: master({ txStyles: txStyles({ body: lvl(1, BULLET) }) }),
      });
      expect(shown).toEqual(["UL[a|b]"]);
    }),
  );

  it.effect("the layout placeholder's list style comes before the master's", () =>
    Effect.gen(function* () {
      const shown = yield* firstShape({
        slide: tree(sp(para("a") + para("b"), BODY_PH)),
        layout: layout("Two", sp("", `<p:ph type="body" idx="1"/>`, lst(lvl(1, NUMBERED(3))))),
        master: master({ txStyles: txStyles({ body: lvl(1, BULLET) }) }),
      });
      // a start the style gives starts the list; it does not restart every item
      expect(shown).toEqual(["OL3[a|b]"]);
    }),
  );

  it.effect("the master placeholder's list style comes before the master's txStyles", () =>
    Effect.gen(function* () {
      const shown = yield* firstShape({
        slide: tree(sp(para("a"), BODY_PH)),
        layout: layout("L", sp("", BODY_PH)),
        master: master({
          shapes: [sp("", `<p:ph type="body" idx="1"/>`, lst(lvl(1, NUMBERED())))],
          txStyles: txStyles({ body: lvl(1, BULLET) }),
        }),
      });
      expect(shown).toEqual(["OL[a]"]);
    }),
  );

  it.effect("the shape's own list style wins over the layout's", () =>
    Effect.gen(function* () {
      const shown = yield* firstShape({
        slide: tree(sp(para("a"), BODY_PH, lst(lvl(1, NUMBERED())))),
        layout: layout("L", sp("", BODY_PH, lst(lvl(1, BULLET)))),
        master: master({}),
      });
      expect(shown).toEqual(["OL[a]"]);
    }),
  );

  it.effect("buNone at a nearer level cancels an inherited bullet", () =>
    Effect.gen(function* () {
      const body = txStyles({ body: lvl(1, BULLET) });
      expect(
        yield* firstShape({
          slide: tree(sp(para("a"), BODY_PH)),
          layout: layout("L", sp("", BODY_PH, lst(lvl(1, "<a:buNone/>")))),
          master: master({ txStyles: body }),
        }),
      ).toEqual(["P:a"]);
      expect(
        yield* firstShape({
          slide: tree(sp(para("a"), BODY_PH, lst(lvl(1, "<a:buNone/>")))),
          master: master({ txStyles: body }),
        }),
      ).toEqual(["P:a"]);
      // and the paragraph's own bullet over a style's buNone
      expect(
        yield* firstShape({
          slide: tree(sp(`<a:p><a:pPr>${BULLET}</a:pPr><a:r><a:t>a</a:t></a:r></a:p>`, BODY_PH)),
          master: master({ txStyles: txStyles({ body: lvl(1, "<a:buNone/>") }) }),
        }),
      ).toEqual(["UL[a]"]);
    }),
  );

  it.effect("a paragraph's lvl picks the list style's level", () =>
    Effect.gen(function* () {
      const shown = yield* firstShape({
        slide: tree(sp(para("a", 0) + para("b", 1) + para("c", 2) + para("d", 0), BODY_PH)),
        master: master({
          // level 1 has no bullet, level 2 a bullet, level 3 a numbered one
          txStyles: txStyles({
            body: lvl(1, "<a:buNone/>") + lvl(2, BULLET) + lvl(3, NUMBERED(2)),
          }),
        }),
      });
      expect(shown).toEqual(["P:a", "UL[b(OL2[c])]", "P:d"]);
    }),
  );

  it.effect("a bullet the master gives every level nests by lvl", () =>
    Effect.gen(function* () {
      const shown = yield* firstShape({
        slide: tree(sp(para("a", 0) + para("b", 1) + para("c", 0), BODY_PH)),
        master: master({ txStyles: txStyles({ body: lvl(1, BULLET) + lvl(2, BULLET) }) }),
      });
      expect(shown).toEqual(["UL[a(UL[b])|c]"]);
    }),
  );

  it.effect("a paragraph's own bullet at a level beats the style and keeps its own start", () =>
    Effect.gen(function* () {
      const shown = yield* firstShape({
        slide: tree(
          sp(
            `<a:p><a:pPr>${NUMBERED(7)}</a:pPr><a:r><a:t>a</a:t></a:r></a:p>` + para("b"),
            BODY_PH,
          ),
        ),
        master: master({ txStyles: txStyles({ body: lvl(1, NUMBERED(3)) }) }),
      });
      // the first restarts at its own startAt; b inherits 3, which does not restart it
      expect(shown).toEqual(["OL7[a|b]"]);
    }),
  );

  it.effect("run marks come from defRPr, and a run's own attributes win", () =>
    Effect.gen(function* () {
      const { shapes } = yield* read(
        yield* deckOf({
          slide: tree(sp(para("x") + para("y", undefined, `b="0"`), BODY_PH)),
          master: master({
            txStyles: txStyles({
              body: lvl(1, '<a:buNone/><a:defRPr b="1" i="1" u="sng" strike="sngStrike"/>'),
            }),
          }),
        }),
      );
      const [x, y] = (shapes[0] ?? []).map((b) =>
        Predicate.isTagged(b, "Para") ? marks(b.content[0]) : [],
      );
      expect(x).toEqual(["Strikeout", "Underline", "Strong", "Emph"]);
      // b="0" turns bold off; the rest is still inherited
      expect(y).toEqual(["Strikeout", "Underline", "Emph"]);
    }),
  );

  it.effect("a title placeholder still reads as a header and takes the titleStyle", () =>
    Effect.gen(function* () {
      const shown = yield* firstShape({
        slide: tree(sp(para("T"), `<p:ph type="title"/>`)),
        // the bodyStyle's bullet must not reach a title
        master: master({
          txStyles: txStyles({ body: lvl(1, BULLET), title: lvl(1, "<a:buNone/>") }),
        }),
      });
      expect(shown).toEqual(["H:T"]);
    }),
  );

  it.effect("a centred title takes the layout's and master's title placeholders", () =>
    Effect.gen(function* () {
      const { shapes } = yield* read(
        yield* deckOf({
          slide: tree(sp(para("T"), `<p:ph type="ctrTitle"/>`)),
          layout: layout("L", sp("", `<p:ph type="ctrTitle"/>`, lst(lvl(1, "<a:buNone/>")))),
          master: master({ shapes: [sp("", `<p:ph type="title"/>`)], txStyles: txStyles({}) }),
        }),
      );
      expect(showAll(shapes[0] ?? [])).toEqual(["H:T"]);
    }),
  );

  it.effect("a text box takes the otherStyle, not the bodyStyle", () =>
    Effect.gen(function* () {
      expect(
        yield* firstShape({
          slide: tree(sp(para("a"))),
          master: master({ txStyles: txStyles({ body: lvl(1, BULLET) }) }),
        }),
      ).toEqual(["P:a"]);
      expect(
        yield* firstShape({
          slide: tree(sp(para("a"))),
          master: master({ txStyles: txStyles({ other: lvl(1, BULLET) }) }),
        }),
      ).toEqual(["UL[a]"]);
    }),
  );

  it.effect("the presentation's defaultTextStyle is the last resort", () =>
    Effect.gen(function* () {
      const defaults = `<p:defaultTextStyle>${lvl(1, BULLET)}</p:defaultTextStyle>`;
      const presentation = (xml: string) =>
        xml.replace("</p:presentation>", `${defaults}</p:presentation>`);
      expect(yield* firstShape({ slide: tree(sp(para("a"))), presentation })).toEqual(["UL[a]"]);
      // a nearer style overrides it
      expect(
        yield* firstShape({
          slide: tree(sp(para("a"))),
          presentation,
          master: master({ txStyles: txStyles({ other: lvl(1, "<a:buNone/>") }) }),
        }),
      ).toEqual(["P:a"]);
    }),
  );

  it.effect("a placeholder matches the layout's by idx before type", () =>
    Effect.gen(function* () {
      const shown = yield* firstShape({
        slide: tree(sp(para("a"), `<p:ph type="body" idx="2"/>`)),
        layout: layout(
          "Two columns",
          sp("", `<p:ph type="body" idx="1"/>`, lst(lvl(1, BULLET))),
          sp("", `<p:ph type="body" idx="2"/>`, lst(lvl(1, NUMBERED()))),
        ),
        master: master({}),
      });
      expect(shown).toEqual(["OL[a]"]);
    }),
  );

  it.effect(
    "without a matching idx the first placeholder of the type (then its family) is used",
    () =>
      Effect.gen(function* () {
        expect(
          yield* firstShape({
            slide: tree(sp(para("a"), `<p:ph type="body" idx="9"/>`)),
            layout: layout("L", sp("", `<p:ph type="body" idx="1"/>`, lst(lvl(1, NUMBERED())))),
            master: master({}),
          }),
        ).toEqual(["OL[a]"]);
        // a subtitle finds the layout's body placeholder
        expect(
          yield* firstShape({
            slide: tree(sp(para("a"), `<p:ph type="subTitle" idx="1"/>`)),
            layout: layout("L", sp("", `<p:ph type="body" idx="5"/>`, lst(lvl(1, BULLET)))),
            master: master({}),
          }),
        ).toEqual(["UL[a]"]);
      }),
  );

  it.effect("Slide.layout is the layout's name", () =>
    Effect.gen(function* () {
      const { layout: name } = yield* read(
        yield* deckOf({ slide: tree(sp(para("a"))), layout: layout("Title and Content") }),
      );
      expect(name).toBe("Title and Content");
    }),
  );

  it.effect("a slide with no layout relationship reads as before, with a diagnostic", () =>
    Effect.gen(function* () {
      const content = yield* deckOf({
        slide: tree(sp(para("a"), BODY_PH)),
        edit: (files) => {
          files["ppt/slides/_rels/slide1.xml.rels"] = strToU8(
            `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`,
          );
        },
      });
      const [result, diagnostics] = yield* collectDiagnostics(read(content));
      expect(result.layout).toBeUndefined();
      expect(showAll(result.shapes[0] ?? [])).toEqual(["P:a"]);
      expect(diagnostics.map((d) => [d.code, d.path])).toEqual([
        ["pptx.layoutMissing", ["ppt/slides/slide1.xml"]],
      ]);
    }),
  );

  it.effect("a layout with no master keeps its own styles and reports the master", () =>
    Effect.gen(function* () {
      const content = yield* deckOf({
        slide: tree(sp(para("a"), BODY_PH)),
        layout: layout("L", sp("", BODY_PH, lst(lvl(1, BULLET)))),
        edit: (files) => {
          files["ppt/slideLayouts/_rels/slideLayout1.xml.rels"] = strToU8(
            `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`,
          );
        },
      });
      const [result, diagnostics] = yield* collectDiagnostics(read(content));
      expect(result.layout).toBe("L");
      expect(showAll(result.shapes[0] ?? [])).toEqual(["UL[a]"]);
      expect(diagnostics.map((d) => d.code)).toEqual(["pptx.masterMissing"]);
    }),
  );

  it.effect("a layout part that is missing or malformed is a diagnostic, not a failure", () =>
    Effect.gen(function* () {
      const missing = yield* deckOf({
        slide: tree(sp(para("a"), BODY_PH)),
        edit: (files) => {
          delete files["ppt/slideLayouts/slideLayout1.xml"];
        },
      });
      const [a, notesA] = yield* collectDiagnostics(read(missing));
      expect(showAll(a.shapes[0] ?? [])).toEqual(["P:a"]);
      expect(notesA.map((d) => d.code)).toEqual(["pptx.layoutUnreadable"]);
      const broken = yield* deckOf({ slide: tree(sp(para("a"), BODY_PH)), layout: "<p:sldLayout" });
      const [b, notesB] = yield* collectDiagnostics(read(broken));
      expect(showAll(b.shapes[0] ?? [])).toEqual(["P:a"]);
      expect(notesB.map((d) => d.code)).toEqual(["pptx.layoutUnreadable"]);
    }),
  );
});
