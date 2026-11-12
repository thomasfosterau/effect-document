import { it } from "@effect/vitest";
import { assert, describe, expect } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import {
  document,
  header,
  para,
  plainText,
  str,
  strong,
  emph,
  link,
  bulletList,
  orderedList,
  table,
  slide,
  slideShow,
  textBox,
  blocksToText,
  type Block,
  trustAs,
  type FeaturesOf,
  convert,
  contentToText,
  type SlideShow,
} from "@thomasfosterau/effect-document";
import { Docx, Pptx } from "@thomasfosterau/effect-document/ooxml";
import * as Rtf from "@thomasfosterau/effect-document/rtf";

const isSlideShow = (block: Block): block is SlideShow => Predicate.isTagged(block, "SlideShow");

// A rich Word document touching links, lists and tables.
const richDocx = trustAs<FeaturesOf<typeof Docx.profile>>(
  document([
    header(1, [str("Report")]),
    para([
      str("See "),
      link([str("the site")], "https://example.com"),
      str(" for "),
      strong([str("details")]),
      str("."),
    ]),
    bulletList([[plainText("first")], [plainText("second")]]),
    orderedList([[plainText("one")], [plainText("two")]]),
    table({ headers: ["A", "B"], rows: [[[plainText("1")], [plainText("2")]]] }),
  ]),
);
const docxBytes = () =>
  Effect.gen(function* () {
    return yield* Docx.makeDocxWriter().write(richDocx);
  });

// A two-slide deck.
const deck = trustAs<FeaturesOf<typeof Pptx.profile>>(
  document([
    slideShow([
      slide([textBox([header(1, [str("Title")]), para([str("Body "), emph([str("text")])])])]),
      slide([textBox([bulletList([[plainText("a")], [plainText("b")]])])]),
    ]),
  ]),
);
const pptxBytes = () =>
  Effect.gen(function* () {
    return yield* Pptx.makePptxWriter().write(deck);
  });

describe("DOCX -> RTF (narrowing)", () => {
  it.effect("drops/down-converts what RTF can't represent and reports it", () =>
    Effect.gen(function* () {
      const { content, loss } = yield* convert({
        from: Docx.format,
        to: Rtf.format,
        input: yield* docxBytes(),
      });
      const features = loss.entries.map((e) => e.feature);
      expect(features).toEqual(
        expect.arrayContaining([
          "inline.link",
          "block.bulletList",
          "block.orderedList",
          "block.table",
        ]),
      );
      // the rendered RTF still carries the text content
      const rtf = contentToText(content);
      expect(rtf).toContain("Report");
      expect(rtf).toContain("the site");
      expect(rtf).toContain("first");
    }),
  );

  it.effect("the narrowed result actually conforms to the RTF profile", () =>
    Effect.gen(function* () {
      const { content } = yield* convert({
        from: Docx.format,
        to: Rtf.format,
        input: yield* docxBytes(),
      });
      const back = yield* Rtf.makeRtfReader().read(content);
      expect(Rtf.Rtf.is(back)).toBe(true);
    }),
  );
});

describe("RTF -> DOCX (widening)", () => {
  it.effect("is lossless because the RTF profile is a subset of DOCX", () =>
    Effect.gen(function* () {
      const rtf = yield* Rtf.makeRtfWriter().write(
        trustAs<FeaturesOf<typeof Rtf.profile>>(
          document([para([str("plain "), strong([str("bold")])])]),
        ),
      );
      const { content, loss } = yield* convert({ from: Rtf.format, to: Docx.format, input: rtf });
      expect(loss.isLossless).toBe(true);
      const back = yield* Docx.makeDocxReader().read(content);
      expect(Docx.Docx.is(back)).toBe(true);
      expect(blocksToText(back.blocks)).toContain("plain bold");
    }),
  );
});

describe("PPTX -> DOCX (narrowing: slides -> prose)", () => {
  it.effect("flattens slides to prose, reporting the slideshow conversion", () =>
    Effect.gen(function* () {
      const { content, loss } = yield* convert({
        from: Pptx.format,
        to: Docx.format,
        input: yield* pptxBytes(),
      });
      expect(loss.entries.some((e) => e.feature === "deck.slideShow")).toBe(true);
      const back = yield* Docx.makeDocxReader().read(content);
      expect(Docx.Docx.is(back)).toBe(true);
      const text = blocksToText(back.blocks);
      expect(text).toContain("Title");
      expect(text).toContain("Body text");
      expect(text).toContain("a");
    }),
  );
});

describe("PPTX -> RTF (narrowing across families)", () => {
  it.effect("produces conforming RTF with the deck's text", () =>
    Effect.gen(function* () {
      const { content } = yield* convert({
        from: Pptx.format,
        to: Rtf.format,
        input: yield* pptxBytes(),
      });
      const back = yield* Rtf.makeRtfReader().read(content);
      expect(Rtf.Rtf.is(back)).toBe(true);
      expect(blocksToText(back.blocks)).toContain("Body text");
    }),
  );
});

describe("DOCX -> PPTX (prose wrapped into a slide)", () => {
  it.effect("wraps loose prose into a single slide and conforms to PPTX", () =>
    Effect.gen(function* () {
      const { content } = yield* convert({
        from: Docx.format,
        to: Pptx.format,
        input: yield* docxBytes(),
      });
      const back = yield* Pptx.makePptxReader().read(content);
      expect(Pptx.Pptx.is(back)).toBe(true);
      const ss = back.blocks.find(isSlideShow);
      assert(ss !== undefined, "the deck has a slide show");
      expect(ss.slides.length).toBeGreaterThanOrEqual(1);
      expect(blocksToText(back.blocks)).toContain("Report");
    }),
  );
});
