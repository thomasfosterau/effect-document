import { describe, expect, test } from "vite-plus/test";
import { Effect } from "effect";
import {
  document, header, para, plainText, str, strong, emph, link, bulletList,
  orderedList, table, slide, slideShow, textBox, blocksToText, type Block,
  trustAs, type FeaturesOf, convert, contentToText,
} from "@thomasfosterau/effect-document";
import { Docx, Pptx } from "@thomasfosterau/effect-ooxml";
import * as Rtf from "@thomasfosterau/effect-rtf";

const run = <A, E>(e: Effect.Effect<A, E>): A => Effect.runSync(e);

// A rich Word document touching links, lists and tables.
const richDocx = trustAs<FeaturesOf<typeof Docx.profile>>(
  document([
    header(1, [str("Report")]),
    para([str("See "), link([str("the site")], "https://example.com"), str(" for "), strong([str("details")]), str(".")]),
    bulletList([[plainText("first")], [plainText("second")]]),
    orderedList([[plainText("one")], [plainText("two")]]),
    table({ headers: ["A", "B"], rows: [[[plainText("1")], [plainText("2")]]] }),
  ])
);
const docxBytes = () => run(Docx.makeDocxWriter().write(richDocx));

// A two-slide deck.
const deck = trustAs<FeaturesOf<typeof Pptx.profile>>(
  document([
    slideShow([
      slide([textBox([header(1, [str("Title")]), para([str("Body "), emph([str("text")])])])]),
      slide([textBox([bulletList([[plainText("a")], [plainText("b")]])])]),
    ]),
  ])
);
const pptxBytes = () => run(Pptx.makePptxWriter().write(deck));

describe("DOCX -> RTF (narrowing)", () => {
  test("drops/down-converts what RTF can't represent and reports it", () => {
    const { content, loss } = run(convert({ from: Docx.format, to: Rtf.format, input: docxBytes() }));
    const features = loss.entries.map((e) => e.feature);
    expect(features).toEqual(
      expect.arrayContaining(["inline.link", "block.bulletList", "block.orderedList", "block.table"])
    );
    // the rendered RTF still carries the text content
    const rtf = contentToText(content);
    expect(rtf).toContain("Report");
    expect(rtf).toContain("the site");
    expect(rtf).toContain("first");
  });

  test("the narrowed result actually conforms to the RTF profile", () => {
    const { content } = run(convert({ from: Docx.format, to: Rtf.format, input: docxBytes() }));
    const back = run(Rtf.makeRtfReader().read(content));
    expect(Rtf.Rtf.is(back)).toBe(true);
  });
});

describe("RTF -> DOCX (widening)", () => {
  test("is lossless because the RTF profile is a subset of DOCX", () => {
    const rtf = run(Rtf.makeRtfWriter().write(trustAs<FeaturesOf<typeof Rtf.profile>>(
      document([para([str("plain "), strong([str("bold")])])])
    )));
    const { content, loss } = run(convert({ from: Rtf.format, to: Docx.format, input: rtf }));
    expect(loss.isLossless).toBe(true);
    const back = run(Docx.makeDocxReader().read(content));
    expect(Docx.Docx.is(back)).toBe(true);
    expect(blocksToText(back.blocks)).toContain("plain bold");
  });
});

describe("PPTX -> DOCX (narrowing: slides -> prose)", () => {
  test("flattens slides to prose, reporting the slideshow conversion", () => {
    const { content, loss } = run(convert({ from: Pptx.format, to: Docx.format, input: pptxBytes() }));
    expect(loss.entries.some((e) => e.feature === "deck.slideShow")).toBe(true);
    const back = run(Docx.makeDocxReader().read(content));
    expect(Docx.Docx.is(back)).toBe(true);
    const text = blocksToText(back.blocks);
    expect(text).toContain("Title");
    expect(text).toContain("Body text");
    expect(text).toContain("a");
  });
});

describe("PPTX -> RTF (narrowing across families)", () => {
  test("produces conforming RTF with the deck's text", () => {
    const { content } = run(convert({ from: Pptx.format, to: Rtf.format, input: pptxBytes() }));
    const back = run(Rtf.makeRtfReader().read(content));
    expect(Rtf.Rtf.is(back)).toBe(true);
    expect(blocksToText(back.blocks)).toContain("Body text");
  });
});

describe("DOCX -> PPTX (prose wrapped into a slide)", () => {
  test("wraps loose prose into a single slide and conforms to PPTX", () => {
    const { content } = run(convert({ from: Docx.format, to: Pptx.format, input: docxBytes() }));
    const back = run(Pptx.makePptxReader().read(content));
    expect(Pptx.Pptx.is(back)).toBe(true);
    const ss = back.blocks.find((b: Block) => b._tag === "SlideShow");
    expect(ss?._tag).toBe("SlideShow");
    if (ss?._tag === "SlideShow") expect(ss.slides.length).toBeGreaterThanOrEqual(1);
    expect(blocksToText(back.blocks)).toContain("Report");
  });
});
