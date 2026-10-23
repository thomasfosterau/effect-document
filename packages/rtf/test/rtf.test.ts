import * as Arr from "effect/Array";
import * as Predicate from "effect/Predicate";
import { assert, describe, expect, test } from "vite-plus/test";
import * as Effect from "effect/Effect";
import {
  type Block,
  blocksToText,
  bytes,
  type Content,
  contentToText,
  document,
  emph,
  type FeaturesOf,
  header,
  para,
  str,
  strong,
  text,
  trustAs,
} from "@thomasfosterau/effect-document";
import { Rtf, makeRtfReader, makeRtfWriter, type RtfWriterOptions } from "../src/index.ts";

const run = <A, E>(e: Effect.Effect<A, E>): A => Effect.runSync(e);
type RtfF = FeaturesOf<typeof Rtf>;
const doc = (blocks: ReadonlyArray<Block>) => trustAs<RtfF>(document(blocks));

describe("RTF writer", () => {
  test("emits a valid RTF wrapper with paragraphs", () => {
    const out = run(makeRtfWriter().write(doc([para([str("hello")])])));
    expect(out._tag).toBe("Text");
    assert(Predicate.isTagged(out, "Text"));
    expect(out.text.startsWith("{\\rtf1")).toBe(true);
    expect(out.text).toContain("\\pard hello\\par");
    expect(out.text.endsWith("}")).toBe(true);
  });

  test("renders bold/italic with localized groups", () => {
    const out = contentToText(
      run(makeRtfWriter().write(doc([para([strong([str("b")]), emph([str("i")])])]))),
    );
    expect(out).toContain("{\\b b}");
    expect(out).toContain("{\\i i}");
  });

  test("escapes braces and backslashes", () => {
    const out = contentToText(run(makeRtfWriter().write(doc([para([str("a{b}\\c")])]))));
    expect(out).toContain("a\\{b\\}\\\\c");
  });

  const write = (blocks: ReadonlyArray<Block>, options?: RtfWriterOptions): string =>
    contentToText(run(makeRtfWriter(options).write(doc(blocks))));

  test("astral characters are written as a signed surrogate pair, and round-trip", () => {
    const out = write([para([str("a\u{1f600}b￿")])]);
    expect(out).toContain("a\\u-10179?\\u-8704?b\\u-1?");
    const back = run(makeRtfReader().read(text(out)));
    expect(blocksToText(back.blocks)).toBe("a\u{1f600}b￿");
  });

  test("control characters are escaped as \\uN, not passed through raw", () => {
    const out = write([para([str("a\rb\u0001c\u007f")])]);
    expect(out).toContain("a\\u13?b\\u1?c\\u127?");
    expect(blocksToText(run(makeRtfReader().read(text(out))).blocks)).toBe("a\rb\u0001c\u007f");
  });

  test("the header declares the code page, \\uc1, a font table, colour table and stylesheet", () => {
    const out = write([para([str("x")])]);
    expect(out.startsWith("{\\rtf1\\ansi\\ansicpg1252\\deff0\\uc1")).toBe(true);
    expect(out).toContain(
      "{\\fonttbl{\\f0\\fswiss\\fcharset0 Helvetica;}{\\f1\\fmodern\\fcharset0 Courier New;}}",
    );
    expect(out).toContain("{\\colortbl;}");
    expect(out).toContain("{\\s1\\outlinelevel0\\b\\fs36\\sbasedon0\\snext0 heading 1;}");
  });

  test("headings use their heading style", () => {
    expect(write([header(2, [str("H")])])).toContain(
      "\\pard\\s2\\outlinelevel1\\b\\fs32 H\\b0\\fs24\\par",
    );
  });

  test("options: line ending, default font and size, paper size and margins", () => {
    const out = write([para([str("x")]), para([str("y")])], {
      lineEnding: "\r\n",
      font: "Times New Roman",
      fontSize: 11,
      paperWidth: 11906,
      paperHeight: 16838,
      marginLeft: 1440,
      marginRight: 1440,
      marginTop: 720,
      marginBottom: 720,
    });
    expect(out).toContain("{\\f0\\fswiss\\fcharset0 Times New Roman;}");
    expect(out).toContain(
      "\\paperw11906\\paperh16838\\margl1440\\margr1440\\margt720\\margb720\\f0\\fs22",
    );
    expect(out).toContain("\\pard x\\par\r\n\\pard y\\par\r\n");
    expect(out.replaceAll("\r\n", "")).not.toContain("\n");
  });
});

describe("RTF reader", () => {
  test("round-trips paragraphs and inline formatting", () => {
    const input = doc([
      para([str("Hello "), strong([str("bold")]), str(" "), emph([str("italic")])]),
    ]);
    const rtf = run(makeRtfWriter().write(input));
    const back = run(makeRtfReader().read(rtf));
    expect(back.blocks.map((b) => b._tag)).toEqual(["Para"]);
    expect(blocksToText(back.blocks)).toBe("Hello bold italic");
    // formatting survived: there is a Strong and an Emph somewhere
    const para0 = back.blocks[0];
    expect(para0?._tag).toBe("Para");
    assert(para0?._tag === "Para");
    const tags = para0.content.map((i) => i._tag);
    expect(tags).toContain("Strong");
    expect(tags).toContain("Emph");
    expect(Rtf.is(back)).toBe(true);
  });

  test("headings round-trip through heading styles", () => {
    const input = doc([header(1, [str("Title")]), header(3, [str("Sub")]), para([str("body")])]);
    const back = run(makeRtfReader().read(run(makeRtfWriter().write(input))));
    expect(back.blocks).toEqual(input.blocks);
    expect(Rtf.is(back)).toBe(true);
  });

  test("\\outlinelevelN and heading-named styles are read as headings, until \\pard", () => {
    const styled =
      "{\\rtf1{\\stylesheet{\\s0 Normal;}{\\*\\cs10 heading 9;}{\\s2\\b Heading 2;}}" +
      "\\pard\\s2\\b Named\\b0\\par Still\\par\\pard\\outlinelevel3 Outline\\par\\pard Body\\par}";
    const back = run(makeRtfReader().read(text(styled)));
    expect(
      back.blocks.map((b) => (Predicate.isTagged(b, "Header") ? `h${b.level}` : b._tag)),
    ).toEqual(["h2", "h2", "h4", "Para"]);
    // the style's own bold is not Strong
    expect(back.blocks[0]).toEqual(header(2, [str("Named")]));
  });

  test("skips destination groups (font/colour tables)", () => {
    const input = text(
      "{\\rtf1\\ansi{\\fonttbl{\\f0 Arial;}}{\\colortbl;\\red0\\green0\\blue0;}\\pard Visible text\\par}",
    );
    const back = run(makeRtfReader().read(input));
    expect(blocksToText(back.blocks)).toBe("Visible text");
  });

  test("decodes \\uN unicode and \\'hh hex escapes", () => {
    const back = run(makeRtfReader().read(text("{\\rtf1 caf\\'e9 \\u8212?dash\\par}")));
    expect(blocksToText(back.blocks)).toBe("café —dash");
  });

  test("control words take signed parameters and eat one trailing space", () => {
    const back = run(makeRtfReader().read(text("{\\rtf1 \\b1  bold\\b0  plain\\u-3913 ?x\\par}")));
    const p = back.blocks[0];
    expect(p?._tag).toBe("Para");
    assert(p?._tag === "Para");
    expect(p.content.map((i) => i._tag)).toEqual(["Strong", "Str"]);
    // -3913 + 65536 = 0xF0B7; its "?" fallback is skipped
    expect(blocksToText(back.blocks)).toBe(" bold plain\uf0b7x");
  });

  test("control symbols: escaped braces, non-breaking space, ignored symbols", () => {
    const back = run(makeRtfReader().read(text("{\\rtf1 a\\{b\\}c\\~d\\|e\\\\f\\'zz\\par}")));
    expect(blocksToText(back.blocks)).toBe("a{b}c\u00a0de\\fzz");
  });

  test("raw line breaks in the source are ignored", () => {
    const back = run(makeRtfReader().read(text("{\\rtf1 one\r\ntwo\nthree\\par}")));
    expect(blocksToText(back.blocks)).toBe("onetwothree");
  });
});

const readText = (rtf: string): string => blocksToText(run(makeRtfReader().read(text(rtf))).blocks);
const readParas = (rtf: string): ReadonlyArray<string> =>
  run(makeRtfReader().read(text(rtf))).blocks.map((b) => blocksToText([b]));
const readError = (input: Content) => Effect.runSync(Effect.flip(makeRtfReader().read(input)));

describe("RTF reader: character decoding", () => {
  test("\\'hh is decoded through the document code page", () => {
    expect(readText("{\\rtf1\\ansi\\ansicpg1252 \\'93q\\'94 \\'80\\par}")).toBe("“q” €");
    expect(readText("{\\rtf1\\ansi\\ansicpg1251 \\'c0\\'e1\\par}")).toBe("Аб");
  });

  test("cp1252's 0x80–0x9F decode as the WHATWG windows-1252 characters on every Node", () => {
    // Node 22's TextDecoder("windows-1252") yields the C1 controls here (#164)
    const escapes = Arr.makeBy(32, (i) => `\\'${(0x80 + i).toString(16)}`).join("");
    expect(readText(`{\\rtf1\\ansi\\ansicpg1252 ${escapes}\\par}`)).toBe(
      "€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f\u0090‘’“”•–—˜™š›œ\u009džŸ",
    );
    expect(readText("{\\rtf1\\ansi\\ansicpg1252 \\'7e\\'a0\\'e9\\'ff\\par}")).toBe("~ éÿ");
  });

  test("an unsupported code page decodes as cp1252", () => {
    expect(readText("{\\rtf1\\pc \\'93q\\'94\\par}")).toBe("“q”");
  });

  test("\\'hh is decoded through the active font's \\fcharset, and DBCS pairs combine", () => {
    const rtf =
      "{\\rtf1\\ansi\\ansicpg1252\\deff0{\\fonttbl{\\f0\\fswiss Arial;}{\\f1\\fnil\\fcharset128 MS Mincho;}}" +
      "\\f1 \\'82\\'a0\\'83e\\f0 \\'e9\\par}";
    // \'83e: a lead byte escaped, its trail byte written literally
    expect(readText(rtf)).toBe("あテé");
  });

  test("\\cpg on a font overrides its \\fcharset", () => {
    expect(
      readText("{\\rtf1\\ansi{\\fonttbl{\\f0\\fcharset0\\cpg1253 Greek;}}\\f0 \\'e1\\par}"),
    ).toBe("α");
  });

  test("Bytes input is 7-bit RTF: 8-bit bytes go through the code page, not UTF-8", () => {
    const ascii = (s: string) => [...new TextEncoder().encode(s)];
    const source = new Uint8Array([
      ...ascii("{\\rtf1\\ansi caf"),
      0xe9,
      0x20,
      0x93,
      ...ascii("\\par}"),
    ]);
    expect(blocksToText(run(makeRtfReader().read(bytes(source))).blocks)).toBe("café “");
  });

  test("\\ucN sets the fallback length, and \\uc0 skips nothing", () => {
    expect(readText("{\\rtf1\\uc0 a\\u8212 bc\\par}")).toBe("a—bc");
    expect(readText("{\\rtf1\\uc2 a\\u8212??bc\\par}")).toBe("a—bc");
    // \uc is scoped to its group
    expect(readText("{\\rtf1 {\\uc2 \\u8212??}\\u8212?x\\par}")).toBe("——x");
  });

  test("a \\'hh fallback counts as one character", () => {
    expect(readText("{\\rtf1 \\u8212\\'97x\\par}")).toBe("—x");
  });

  test("\\u surrogate pairs combine; negative values are N + 65536", () => {
    expect(readText("{\\rtf1 a\\u-10179?\\u-8704?b\\par}")).toBe("a\u{1f600}b");
    expect(readText("{\\rtf1 \\u-1?\\par}")).toBe("￿");
    // an unpaired surrogate is replaced, not kept as an ill-formed string
    expect(readText("{\\rtf1 \\u-10179?x\\par}")).toBe("�x");
  });

  test("an out-of-range \\u parameter fails with a ParseError, not a defect", () => {
    for (const param of ["-99999", "-32769", "65536", "99999999999"]) {
      expect(readError(text(`{\\rtf1 \\u${param}?\\par}`))._tag).toBe("ParseError");
    }
  });
});

describe("RTF reader: formatting state", () => {
  test("\\plain resets character formatting", () => {
    const back = run(makeRtfReader().read(text("{\\rtf1 \\b\\i bold\\plain not\\par}")));
    const p = back.blocks[0];
    expect(p?._tag).toBe("Para");
    assert(p?._tag === "Para");
    expect(p.content.map((i) => i._tag)).toEqual(["Strong", "Str"]);
    expect(blocksToText(back.blocks)).toBe("boldnot");
  });

  test("special-character control words and control symbols", () => {
    const rtf =
      "{\\rtf1 don\\rquote t \\lquote a\\rquote  \\ldblquote b\\rdblquote  1\\endash 2\\emdash 3\\bullet " +
      "\\enspace\\emspace\\qmspace\\zwj\\zwnj\\zwbo\\zwnbo x\\-y\\_z\\par}";
    expect(readText(rtf)).toBe("don’t ‘a’ “b” 1–2—3•   ‍‌​⁠x­y‑z");
  });
});

describe("RTF reader: destinations and structure", () => {
  test("cells are tab-separated; rows, sections, pages and columns break paragraphs", () => {
    expect(readParas("{\\rtf1 A\\cell B\\cell\\row \\cell D\\cell\\row}")).toEqual(["A\tB", "\tD"]);
    expect(readParas("{\\rtf1 a\\sect b\\page c\\column d}")).toEqual(["a", "b", "c", "d"]);
  });

  test("footnotes, hidden text, deletions, field instructions and list text are not body text", () => {
    expect(readParas("{\\rtf1 a{\\footnote \\pard note\\par}b\\par}")).toEqual(["ab"]);
    expect(readText("{\\rtf1 a{\\v hidden}b\\v x\\v0 c\\par}")).toBe("abc");
    expect(readText("{\\rtf1 a{\\deleted gone}b\\par}")).toBe("ab");
    expect(
      readText(
        '{\\rtf1 {\\field{\\fldinst HYPERLINK "https://example.com"}{\\fldrslt link}}\\par}',
      ),
    ).toBe("link");
    expect(readText("{\\rtf1 {\\listtext \\'b7\\tab}item\\par}")).toBe("item");
  });

  test("unstarred destinations are skipped", () => {
    const words = [
      "annotation",
      "atnid",
      "atnauthor",
      "object",
      "objdata",
      "nonshppict",
      "shp",
      "shpinst",
      "shprslt",
      "xe",
      "tc",
      "header",
      "headerf",
      "footerl",
      "ftnsep",
      "ftnsepc",
      "ftncn",
      "revtbl",
      "pgdsctbl",
      "filetbl",
      "listtable",
      "listoverridetable",
      "rsidtbl",
      "generator",
      "xmlnstbl",
      "themedata",
      "colorschememapping",
      "datastore",
      "latentstyles",
      "mmathPr",
    ];
    for (const word of words) expect(readText(`{\\rtf1 a{\\${word} hidden}b\\par}`)).toBe("ab");
  });
});

describe("RTF reader: lexer and robustness", () => {
  test("\\binN data is skipped, even when it contains braces", () => {
    expect(readText("{\\rtf1 a{\\pict\\bin4 }}{x}b\\par}")).toBe("ab");
    expect(readText("{\\rtf1 a\\bin3 {}\\c\\par}")).toBe("ac");
  });

  test("a bare - after a control word is text, not a parameter", () => {
    expect(readText("{\\rtf1 x\\tab-y\\par}")).toBe("x\t-y");
  });

  test("text after the outermost group is ignored", () => {
    expect(readParas("{\\rtf1 a\\par}garbage\\par")).toEqual(["a"]);
  });

  test("non-RTF input fails with a ParseError", () => {
    expect(readError(text("hello world"))._tag).toBe("ParseError");
  });
});
