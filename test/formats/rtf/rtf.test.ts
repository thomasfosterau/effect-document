import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  document, emph, header, para, str, strong, blocksToText, type Block,
} from "../../../src/schema/index.js";
import { trustAs, type FeaturesOf } from "../../../src/profile/profile.js";
import { text, contentToText } from "../../../src/io/content.js";
import { Rtf, makeRtfReader, makeRtfWriter } from "../../../src/formats/rtf/index.js";

const run = <A, E>(e: Effect.Effect<A, E>): A => Effect.runSync(e);
type RtfF = FeaturesOf<typeof Rtf>;
const doc = (blocks: ReadonlyArray<Block>) => trustAs<RtfF>(document(blocks));

describe("RTF writer", () => {
  test("emits a valid RTF wrapper with paragraphs", () => {
    const out = run(makeRtfWriter().write(doc([para([str("hello")])])));
    expect(out._tag).toBe("Text");
    if (out._tag === "Text") {
      expect(out.text.startsWith("{\\rtf1")).toBe(true);
      expect(out.text).toContain("\\pard hello\\par");
      expect(out.text.endsWith("}")).toBe(true);
    }
  });

  test("renders bold/italic with localized groups", () => {
    const out = contentToText(
      run(makeRtfWriter().write(doc([para([strong([str("b")]), emph([str("i")])])])))
    );
    expect(out).toContain("{\\b b}");
    expect(out).toContain("{\\i i}");
  });

  test("escapes braces and backslashes", () => {
    const out = contentToText(run(makeRtfWriter().write(doc([para([str("a{b}\\c")])]))));
    expect(out).toContain("a\\{b\\}\\\\c");
  });
});

describe("RTF reader", () => {
  test("round-trips paragraphs and inline formatting", () => {
    const input = doc([para([str("Hello "), strong([str("bold")]), str(" "), emph([str("italic")])])]);
    const rtf = run(makeRtfWriter().write(input));
    const back = run(makeRtfReader().read(rtf));
    expect(back.blocks.map((b) => b._tag)).toEqual(["Para"]);
    expect(blocksToText(back.blocks)).toBe("Hello bold italic");
    // formatting survived: there is a Strong and an Emph somewhere
    const para0 = back.blocks[0];
    expect(para0?._tag).toBe("Para");
    if (para0?._tag === "Para") {
      const tags = para0.content.map((i) => i._tag);
      expect(tags).toContain("Strong");
      expect(tags).toContain("Emph");
    }
    expect(Rtf.is(back)).toBe(true);
  });

  test("headings become bold paragraphs (RTF has no semantic headings)", () => {
    const rtf = run(makeRtfWriter().write(doc([header(1, [str("Title")])])));
    const back = run(makeRtfReader().read(rtf));
    expect(back.blocks[0]?._tag).toBe("Para");
    expect(blocksToText(back.blocks)).toBe("Title");
  });

  test("skips destination groups (font/colour tables)", () => {
    const input = text(
      "{\\rtf1\\ansi{\\fonttbl{\\f0 Arial;}}{\\colortbl;\\red0\\green0\\blue0;}\\pard Visible text\\par}"
    );
    const back = run(makeRtfReader().read(input));
    expect(blocksToText(back.blocks)).toBe("Visible text");
  });

  test("decodes \\uN unicode and \\'hh hex escapes", () => {
    const back = run(makeRtfReader().read(text("{\\rtf1 caf\\'e9 \\u8212?dash\\par}")));
    expect(blocksToText(back.blocks)).toBe("café —dash");
  });
});
