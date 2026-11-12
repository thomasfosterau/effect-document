/**
 * `narrow` degrades instead of dropping (#111): a grid becomes paragraphs in a
 * target without tables, a horizontal rule a `***` paragraph, an image its alt
 * text and URL; each reported as `converted`.
 */

import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import { describe, expect, test } from "vite-plus/test";
import {
  blocksToText,
  convert,
  defineProfile,
  document,
  Image,
  narrow,
  para,
  str,
  text,
} from "@thomasfosterau/effect-document";
import { HorizontalRule } from "@thomasfosterau/effect-document/schema";
import * as Csv from "@thomasfosterau/effect-document/csv";
import * as Rtf from "@thomasfosterau/effect-document/rtf";

const Prose = defineProfile("prose", ["block.para", "inline.str", "inline.space"]);

describe("narrow degrades content (#111)", () => {
  test("CSV -> RTF keeps the data as a paragraph per row", async () => {
    const { content, loss } = await Effect.runPromise(
      convert({ from: Csv.format, to: Rtf.format, input: text("a,b\n1,2\n") }),
    );
    const back = await Effect.runPromise(Rtf.makeRtfReader().read(content));
    expect(blocksToText(back.blocks)).toBe("a\tb\n1\t2");
    expect(loss.entries.map((e) => [e.feature, e.action])).toEqual([
      ["sheet.worksheet", "converted"],
    ]);
  });

  test("a horizontal rule becomes a *** paragraph", () => {
    const { document: out, loss } = narrow(document([new HorizontalRule({})]), Prose);
    expect(blocksToText(out.blocks)).toBe("***");
    expect(loss.entries.map((e) => e.action)).toEqual(["converted"]);
  });

  test("an image keeps its alt text and URL", () => {
    const image = new Image({ alt: [str("logo")], target: { url: "https://example.com/l.png" } });
    const { document: out } = narrow(document([para([image])]), Prose);
    expect(blocksToText(out.blocks)).toBe("logo (https://example.com/l.png)");
    const bare = new Image({ alt: [], target: { url: "x.png" } });
    expect(blocksToText(narrow(document([para([bare])]), Prose).document.blocks)).toBe("(x.png)");
    expect(out.blocks.every((b) => Predicate.isTagged(b, "Para"))).toBe(true);
  });
});
