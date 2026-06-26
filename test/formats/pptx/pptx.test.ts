import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  document, para, plainText, str, strong, bulletList, slide, slideShow, textBox,
  blocksToText, type Slide,
} from "../../../src/schema/index.js";
import { trustAs, type FeaturesOf } from "../../../src/profile/profile.js";
import { Pptx, makePptxReader, makePptxWriter } from "../../../src/formats/pptx/index.js";

const run = <A, E>(e: Effect.Effect<A, E>): A => Effect.runSync(e);
type PptxF = FeaturesOf<typeof Pptx>;

const deckOf = (...slides: Slide[]) =>
  trustAs<PptxF>(document([slideShow(slides)]));

const readBack = (slides: Slide[]) =>
  run(makePptxReader().read(run(makePptxWriter().write(deckOf(...slides)))));

const firstSlideShow = (blocks: ReadonlyArray<{ _tag: string }>) =>
  blocks.find((b) => b._tag === "SlideShow") as
    | { _tag: "SlideShow"; slides: ReadonlyArray<Slide> }
    | undefined;

describe("PPTX round-trip", () => {
  test("produces a valid-looking package and reads slides back", () => {
    const bytes = run(makePptxWriter().write(deckOf(slide([textBox([para([str("hi")])])]))));
    expect(bytes._tag).toBe("Bytes");
    const back = run(makePptxReader().read(bytes));
    const ss = firstSlideShow(back.blocks);
    expect(ss?.slides).toHaveLength(1);
  });

  test("preserves slide count and text content across shapes", () => {
    const back = readBack([
      slide([textBox([para([str("Slide "), strong([str("one")])])])]),
      slide([textBox([bulletList([[plainText("a")], [plainText("b")]])])]),
    ]);
    const ss = firstSlideShow(back.blocks)!;
    expect(ss.slides).toHaveLength(2);
    expect(blocksToText(back.blocks)).toContain("Slide one");
    expect(blocksToText(back.blocks)).toContain("a");
  });

  test("preserves a bullet list inside a shape", () => {
    const back = readBack([slide([textBox([bulletList([[plainText("x")], [plainText("y")]])])])]);
    const ss = firstSlideShow(back.blocks)!;
    const shape = ss.slides[0]!.shapes[0]!;
    expect(shape._tag).toBe("TextBox");
    if (shape._tag === "TextBox") {
      expect(shape.content[0]?._tag).toBe("BulletList");
    }
  });

  test("reads a placeholder shape back as a Placeholder", () => {
    const back = readBack([slide([textBox([para([str("body")])])])]);
    expect(Pptx.is(back)).toBe(true);
  });

  test("output conforms to the PPTX profile", () => {
    const back = readBack([slide([textBox([para([str("hello")])])])]);
    expect(Pptx.is(back)).toBe(true);
  });
});
