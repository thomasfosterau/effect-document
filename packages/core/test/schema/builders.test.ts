import * as Schema from "effect/Schema";
import { describe, expect, test } from "vite-plus/test";
import {
  blockQuote,
  code,
  definitionList,
  div,
  Document,
  document,
  emph,
  figure,
  horizontalRule,
  image,
  lineBlock,
  lineBreak,
  math,
  normalizeInlines,
  note,
  para,
  picture,
  placeholder,
  quoted,
  rawBlock,
  rawInline,
  smallCaps,
  softBreak,
  space,
  span,
  str,
  strikeout,
  subscript,
  superscript,
  textInlines,
  underline,
} from "../../src/schema/index.ts";
import { collectFeatures } from "../../src/profile/index.ts";

describe("builders (#125)", () => {
  test("every builder makes a node the schema round-trips, under its feature", () => {
    const inlines = [
      underline([str("u")]),
      strikeout([str("s")]),
      superscript([str("2")]),
      subscript([str("i")]),
      smallCaps([str("sc")]),
      quoted([str("q")]),
      quoted([str("q")], "single"),
      code("x = 1", { classes: ["js"] }),
      math("e^{i\\pi}"),
      math("x", "display"),
      rawInline("html", "<br>"),
      image("a.png", [str("alt")], "title"),
      note([para([str("n")])]),
      span([str("s")], { id: "s1" }),
      lineBreak(),
    ];
    const doc = document([
      para(inlines),
      blockQuote([para([str("q")])]),
      div([para([str("d")])], { classes: ["box"] }),
      figure([para([image("f.png")])], [para([str("caption")])]),
      definitionList([[[str("term")], [[para([str("definition")])]]]]),
      lineBlock([[str("one")], [str("two")]]),
      horizontalRule(),
      rawBlock("tex", "\\newpage"),
    ]);
    expect(Schema.decodeSync(Document)(Schema.encodeSync(Document)(doc))).toEqual(doc);
    const features = collectFeatures(doc);
    expect(
      (
        [
          "inline.underline",
          "inline.strikeout",
          "inline.superscript",
          "inline.subscript",
          "inline.smallCaps",
          "inline.quoted",
          "inline.code",
          "inline.math",
          "inline.rawInline",
          "inline.image",
          "inline.note",
          "inline.span",
          "inline.lineBreak",
          "block.blockQuote",
          "block.div",
          "block.figure",
          "block.definitionList",
          "block.lineBlock",
          "block.horizontalRule",
          "block.rawBlock",
        ] as const
      ).filter((f) => !features.has(f)),
    ).toEqual([]);
  });

  test("optional fields are left out when not given", () => {
    expect(Object.hasOwn(code("x"), "attr")).toBe(false);
    expect(Object.hasOwn(image("a.png").target, "title")).toBe(false);
    expect(Object.hasOwn(picture("a.png"), "alt")).toBe(false);
    expect(picture("a.png", "logo").alt).toBe("logo");
    expect(placeholder("title", [para([str("T")])], 0).idx).toBe(0);
  });
});

describe("textInlines (#125)", () => {
  test("splits words, spaces and line breaks as Pandoc's text builder does", () => {
    expect(textInlines("  hello   world\nagain ")).toEqual([
      str("hello"),
      space(),
      str("world"),
      softBreak(),
      str("again"),
    ]);
    expect(textInlines("")).toEqual([]);
    expect(textInlines("one")).toEqual([str("one")]);
  });
});

describe("normalizeInlines (#125)", () => {
  test("merges adjacent Strs, drops empty ones and collapses whitespace runs", () => {
    expect(
      normalizeInlines([
        str("he"),
        str(""),
        str("llo"),
        space(),
        space(),
        str("w"),
        space(),
        softBreak(),
        str("x"),
      ]),
    ).toEqual([str("hello"), space(), str("w"), softBreak(), str("x")]);
  });

  test("leaves containers' content alone", () => {
    const inner = emph([str("a"), str("b")]);
    expect(normalizeInlines([inner])).toEqual([inner]);
  });
});
