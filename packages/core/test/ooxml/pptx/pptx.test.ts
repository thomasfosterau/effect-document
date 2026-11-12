import { it } from "@effect/vitest";
import * as Predicate from "effect/Predicate";
import { assert, describe, expect, test } from "vite-plus/test";
import * as Effect from "effect/Effect";
import { strToU8, unzipSync, zipSync } from "fflate";
import {
  type Block,
  type Content,
  blocksToText,
  bulletList,
  bytes,
  document,
  header,
  OrderedList,
  orderedList,
  Placeholder,
  type FeaturesOf,
  para,
  plainText,
  slide,
  type Slide,
  slideShow,
  str,
  strong,
  textBox,
  trustAs,
  narrow,
} from "@thomasfosterau/effect-document";
import { Pptx, makePptxReader, makePptxWriter } from "../../../src/ooxml/pptx/index.ts";

type PptxF = FeaturesOf<typeof Pptx>;

const deckOf = (...slides: Slide[]) => trustAs<PptxF>(document([slideShow(slides)]));

const readBack = (slides: Slide[]) =>
  Effect.gen(function* () {
    return yield* makePptxReader().read(yield* makePptxWriter().write(deckOf(...slides)));
  });

const firstSlideShow = (blocks: ReadonlyArray<Block>) =>
  blocks.find((b) => Predicate.isTagged(b, "SlideShow"));

/** The blocks of the first shape on the first slide of a deck read back from `blocks`. */
const shapeBack = (blocks: Parameters<typeof textBox>[0]) =>
  Effect.gen(function* () {
    const ss = firstSlideShow((yield* readBack([slide([textBox(blocks)])])).blocks);
    const shape = ss?.slides[0]?.shapes[0];
    assert(shape !== undefined && Predicate.isTagged(shape, "TextBox"), "expected a text box");
    return shape.content;
  });

const NS = `xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"`;
/** A slide shape holding `paras`, with `ph` in its `nvPr`. */
const sp = (paras: string, ph = "") =>
  `<p:sp><p:nvSpPr><p:cNvPr id="2" name="s"/><p:cNvSpPr/><p:nvPr>${ph}</p:nvPr></p:nvSpPr>` +
  `<p:spPr/><p:txBody><a:bodyPr/>${paras}</p:txBody></p:sp>`;
/** A one-run DrawingML paragraph. */
const para1 = (text: string, rPr = "") => `<a:p><a:r><a:rPr ${rPr}/><a:t>${text}</a:t></a:r></a:p>`;
/** A bulleted (or auto-numbered) paragraph at `lvl`. */
const bu = (text: string, lvl: number, auto = false) =>
  `<a:p><a:pPr lvl="${lvl}">${auto ? `<a:buAutoNum type="arabicPeriod"/>` : `<a:buChar char="-"/>`}</a:pPr><a:r><a:t>${text}</a:t></a:r></a:p>`;

describe("PPTX round-trip", () => {
  it.effect("produces a valid-looking package and reads slides back", () =>
    Effect.gen(function* () {
      const out = yield* makePptxWriter().write(deckOf(slide([textBox([para([str("hi")])])])));
      expect(out._tag).toBe("Bytes");
      const back = yield* makePptxReader().read(out);
      const ss = firstSlideShow(back.blocks);
      expect(ss?.slides).toHaveLength(1);
    }),
  );

  it.effect("preserves slide count and text content across shapes", () =>
    Effect.gen(function* () {
      const back = yield* readBack([
        slide([textBox([para([str("Slide "), strong([str("one")])])])]),
        slide([textBox([bulletList([[plainText("a")], [plainText("b")]])])]),
      ]);
      const ss = firstSlideShow(back.blocks)!;
      expect(ss.slides).toHaveLength(2);
      expect(blocksToText(back.blocks)).toContain("Slide one");
      expect(blocksToText(back.blocks)).toContain("a");
    }),
  );

  it.effect("preserves a bullet list inside a shape", () =>
    Effect.gen(function* () {
      const back = yield* readBack([
        slide([textBox([bulletList([[plainText("x")], [plainText("y")]])])]),
      ]);
      const ss = firstSlideShow(back.blocks)!;
      const shape = ss.slides[0]!.shapes[0]!;
      expect(shape._tag).toBe("TextBox");
      assert(Predicate.isTagged(shape, "TextBox"));
      expect(shape.content[0]?._tag).toBe("BulletList");
    }),
  );

  it.effect("reads a placeholder shape back as a Placeholder", () =>
    Effect.gen(function* () {
      const back = yield* readBack([slide([textBox([para([str("body")])])])]);
      expect(Pptx.is(back)).toBe(true);
    }),
  );

  it.effect("output conforms to the PPTX profile", () =>
    Effect.gen(function* () {
      const back = yield* readBack([slide([textBox([para([str("hello")])])])]);
      expect(Pptx.is(back)).toBe(true);
    }),
  );

  it.effect("a list item's later paragraphs stay in the item (#196)", () =>
    Effect.gen(function* () {
      const blocks = [
        bulletList([
          [plainText("a"), para([str("a, continued")])],
          [
            plainText("b"),
            orderedList([[plainText("b1"), para([str("b1 more")])]]),
            para([str("b more")]),
          ],
        ]),
        para([str("after the list")]),
      ];
      expect(yield* shapeBack(blocks)).toEqual(blocks);
    }),
  );

  it.effect("an item's later paragraph in a title placeholder stays a paragraph (#196)", () =>
    Effect.gen(function* () {
      const content = [bulletList([[plainText("a"), para([str("a, continued")])]])];
      const ss = firstSlideShow(
        (yield* readBack([slide([new Placeholder({ placeholderType: "title", content })])])).blocks,
      );
      const shape = ss?.slides[0]?.shapes[0];
      assert(shape !== undefined && Predicate.isTagged(shape, "Placeholder"));
      expect(shape.content).toEqual(content);
    }),
  );

  it.effect("an item that starts with a nested list keeps it (#196)", () =>
    Effect.gen(function* () {
      const blocks = [bulletList([[bulletList([[plainText("inner")]])], [plainText("b")]])];
      expect(yield* shapeBack(blocks)).toEqual(blocks);
    }),
  );

  it.effect("adjacent ordered lists stay two lists, and keep their start (#196)", () =>
    Effect.gen(function* () {
      const blocks = [
        orderedList([[plainText("a")], [plainText("b")]]),
        new OrderedList({ start: 4, items: [[plainText("c")]] }),
      ];
      expect(yield* shapeBack(blocks)).toEqual(blocks);
    }),
  );
});

/** A writer-made deck whose first slide's shape tree is replaced by `tree`. */
const deckWith = (tree: string, edit?: (files: Record<string, Uint8Array>) => void) =>
  Effect.gen(function* () {
    const out = yield* makePptxWriter().write(deckOf(slide([])));
    assert(Predicate.isTagged(out, "Bytes"), "expected bytes");
    const files = unzipSync(out.bytes);
    files["ppt/slides/slide1.xml"] = strToU8(
      `<p:sld ${NS}><p:cSld><p:spTree><p:nvGrpSpPr/><p:grpSpPr/>${tree}</p:spTree></p:cSld></p:sld>`,
    );
    edit?.(files);
    return bytes(zipSync(files));
  });
const shapesOf = (content: Content) =>
  Effect.gen(function* () {
    return firstSlideShow((yield* makePptxReader().read(content)).blocks)!.slides[0]!.shapes;
  });

/** A deck whose one slide holds a placeholder of `placeholderType` with a heading at `level`. */
const titled = (placeholderType: string, level: number) =>
  document([
    slideShow([
      slide([new Placeholder({ placeholderType, content: [header(level, [str("T")])] })]),
    ]),
  ]);

describe("PPTX reader fixes (#81)", () => {
  it.effect("shapes inside (nested) group shapes are read in order", () =>
    Effect.gen(function* () {
      const tree =
        sp(para1("one")) +
        `<p:grpSp><p:nvGrpSpPr/><p:grpSpPr/>${sp(para1("two"))}` +
        `<p:grpSp><p:nvGrpSpPr/><p:grpSpPr/>${sp(para1("three"))}</p:grpSp></p:grpSp>` +
        sp(para1("four"));
      expect(
        (yield* shapesOf(yield* deckWith(tree))).map((s) =>
          blocksToText(Predicate.isTagged(s, "TextBox") ? s.content : []),
        ),
      ).toEqual(["one", "two", "three", "four"]);
    }),
  );

  it.effect('b="true" and i="true" are recognised', () =>
    Effect.gen(function* () {
      const [shape] = yield* shapesOf(yield* deckWith(sp(para1("x", `b="true" i="true"`))));
      const first =
        shape !== undefined && Predicate.isTagged(shape, "TextBox") ? shape.content[0] : undefined;
      const inline =
        first !== undefined && Predicate.isTagged(first, "Para") ? first.content[0] : undefined;
      expect(inline?._tag).toBe("Strong");
    }),
  );

  it.effect("a placeholder without a type defaults to obj", () =>
    Effect.gen(function* () {
      const [shape] = yield* shapesOf(yield* deckWith(sp(para1("x"), `<p:ph idx="1"/>`)));
      expect(shape).toMatchObject({ _tag: "Placeholder", placeholderType: "obj", idx: 1 });
    }),
  );

  it.effect("title placeholders read as headers and round-trip", () =>
    Effect.gen(function* () {
      const [shape] = yield* shapesOf(
        yield* deckWith(sp(para1("Title"), `<p:ph type="ctrTitle"/>`)),
      );
      expect(shape!._tag === "Placeholder" && shape!.content[0]).toMatchObject({
        _tag: "Header",
        level: 1,
      });

      const back = yield* readBack([
        slide([
          new Placeholder({ placeholderType: "title", content: [header(1, [str("Hello")])] }),
        ]),
      ]);
      const ph = firstSlideShow(back.blocks)!.slides[0]!.shapes[0]!;
      expect(Predicate.isTagged(ph, "Placeholder") && ph.content[0]).toMatchObject({
        _tag: "Header",
        content: [{ _tag: "Str", text: "Hello" }],
      });
    }),
  );

  test("the write profile takes a level-1 heading in a title placeholder only (#196)", () => {
    expect(Pptx.is(titled("title", 1))).toBe(true);
    expect(Pptx.is(titled("ctrTitle", 1))).toBe(true);
    expect(Pptx.is(titled("body", 1))).toBe(false);
    expect(Pptx.is(titled("title", 2))).toBe(false);
    expect(Pptx.is(document([slideShow([slide([textBox([header(1, [str("T")])])])])]))).toBe(false);
    const inList = new Placeholder({
      placeholderType: "title",
      content: [bulletList([[header(1, [str("T")])]])],
    });
    expect(Pptx.is(document([slideShow([slide([inList])])]))).toBe(false);
    // a heading anywhere else narrows to a paragraph, with the rule's reason
    const { loss } = narrow(titled("body", 1), Pptx);
    expect(loss.entries).toEqual([
      expect.objectContaining({
        feature: "block.header",
        action: "converted",
        detail: expect.stringContaining("slide's title"),
      }),
    ]);
  });

  it.effect("a title heading narrows to PPTX losslessly and round-trips (#196)", () =>
    Effect.gen(function* () {
      const doc = document([
        slideShow([
          slide([
            new Placeholder({ placeholderType: "title", content: [header(1, [str("Hello")])] }),
            textBox([para([str("Body")])]),
          ]),
        ]),
      ]);
      const { document: narrowed, loss } = narrow(doc, Pptx);
      expect(loss.isLossless).toBe(true);
      const back = yield* makePptxReader().read(yield* makePptxWriter().write(narrowed));
      expect(Pptx.is(back)).toBe(true);
      expect(firstSlideShow(back.blocks)).toEqual(firstSlideShow(doc.blocks));
    }),
  );

  it.effect("a slide with a missing part fails instead of being skipped", () =>
    Effect.gen(function* () {
      const content = yield* deckWith(sp(para1("x")), (files) => {
        delete files["ppt/slides/slide1.xml"];
      });
      const error = yield* Effect.flip(makePptxReader().read(content));
      expect(error._tag).toBe("ParseError");
      expect(error.reason).toContain("slide1.xml");
    }),
  );

  it.effect("field text and line breaks are kept", () =>
    Effect.gen(function* () {
      const paras = `<a:p><a:r><a:t>Slide </a:t></a:r><a:fld id="{1}" type="slidenum"><a:t>3</a:t></a:fld><a:br/><a:r><a:t>end</a:t></a:r></a:p>`;
      const [shape] = yield* shapesOf(yield* deckWith(sp(paras)));
      expect(blocksToText(shape!._tag === "TextBox" ? shape!.content : [])).toBe("Slide 3\nend");
    }),
  );

  it.effect("lvl nests bullet lists, and nested lists round-trip", () =>
    Effect.gen(function* () {
      const [shape] = yield* shapesOf(
        yield* deckWith(
          sp(bu("a", 0) + bu("a1", 1) + bu("a1i", 2, true) + bu("a2", 1) + bu("b", 0)),
        ),
      );
      const nested = bulletList([
        [
          plainText("a"),
          bulletList([[plainText("a1"), orderedList([[plainText("a1i")]])], [plainText("a2")]]),
        ],
        [plainText("b")],
      ]);
      expect(shape!._tag === "TextBox" && shape!.content).toEqual([nested]);

      const back = yield* readBack([slide([textBox([nested])])]);
      expect(firstSlideShow(back.blocks)!.slides[0]!.shapes[0]).toMatchObject({
        content: [nested],
      });
    }),
  );
});
