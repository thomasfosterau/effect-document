import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  type Block, blocksToText, bulletList, bytes, codeBlock, document, emph, header, type Inline, link,
  orderedList, para, plainText, str, strong, trustAs,
} from "@thomasfosterau/effect-document";
import {
  BlockQuote, Code, HorizontalRule, LineBreak, Strikeout, Underline,
} from "@thomasfosterau/effect-document";
import { Pdf, type PdfFeature, extractPageText, makePdfReader, makePdfWriter } from "../src/index.js";
import {
  PdfBuilder, PdfFile, type PdfObject, bytesToLatin1, latin1ToBytes, pdfArray, pdfDict, pdfName, pdfStream, pdfString, pdfTextString,
} from "../src/cos/index.js";

const run = <A, E>(e: Effect.Effect<A, E>): A => Effect.runSync(e);
const doc = (blocks: ReadonlyArray<Block>, meta: Record<string, unknown> = {}) => trustAs<PdfFeature>(document(blocks, meta));
const write = (blocks: ReadonlyArray<Block>, meta?: Record<string, unknown>, options = {}): Uint8Array => {
  const c = run(makePdfWriter(options).write(doc(blocks, meta)));
  if (c._tag !== "Bytes") throw new Error("expected bytes");
  return c.bytes;
};
const read = (data: Uint8Array) => run(makePdfReader().read(bytes(data)));
const roundTrip = (blocks: ReadonlyArray<Block>, meta?: Record<string, unknown>) => read(write(blocks, meta));
const fixture = async (name: string) => new Uint8Array(await Bun.file(new URL(`./fixtures/${name}`, import.meta.url)).arrayBuffer());

/** A one-page PDF with the given content stream and resources. */
const onePage = (
  content: string,
  resources: Record<string, PdfObject>,
  page: Record<string, PdfObject> = {}
): Uint8Array => {
  const pdf = new PdfBuilder();
  const pages = pdf.alloc();
  const contents = pdf.add(pdfStream(pdfDict(), latin1ToBytes(content)));
  const p = pdf.add(pdfDict({ Type: pdfName("Page"), Parent: pages, MediaBox: pdfArray([0, 0, 612, 792]), Contents: contents, Resources: pdfDict(resources), ...page }));
  pdf.set(pages, pdfDict({ Type: pdfName("Pages"), Kids: pdfArray([p]), Count: 1 }));
  return pdf.build({ root: pdf.add(pdfDict({ Type: pdfName("Catalog"), Pages: pages })) });
};

const helvetica = pdfDict({ Type: pdfName("Font"), Subtype: pdfName("Type1"), BaseFont: pdfName("Helvetica"), Encoding: pdfName("WinAnsiEncoding") });
const textOf = (data: Uint8Array): string => blocksToText(read(data).blocks);

describe("PDF writer", () => {
  test("writes a well-formed PDF with metadata", () => {
    const data = write([para([str("hello")])], { title: "Greeting", author: "Ünïcode Author" });
    const head = new TextDecoder().decode(data.subarray(0, 8));
    expect(head).toBe("%PDF-1.7");
    expect(new TextDecoder().decode(data.subarray(data.length - 6))).toBe("%%EOF\n");
    const file = PdfFile.open(data);
    expect(file.repaired).toBe(false);
    expect(read(data).meta).toMatchObject({ title: "Greeting", author: "Ünïcode Author", producer: "effect-document" });
  });

  test("page size, margin and compression options", () => {
    const data = write([para([str("x")])], {}, { pageSize: "letter", compress: false });
    const page = PdfFile.open(data).pages()[0]!;
    expect(page.mediaBox).toEqual([0, 0, 612, 792]);
    expect(bytesToLatin1(data)).toContain("(x) Tj");
    const custom = PdfFile.open(write([para([str("x")])], {}, { pageSize: [300, 400] })).pages()[0]!;
    expect(custom.mediaBox).toEqual([0, 0, 300, 400]);
  });

  test("characters outside WinAnsiEncoding are written as ?", () => {
    expect(textOf(write([para([str("Café € “ok” 中")])]))).toBe("Café € “ok” ?");
  });

  test("long documents flow onto more pages", () => {
    const blocks = Array.from({ length: 80 }, (_, i) => para([str(`Paragraph ${i} `.repeat(12) + "ends.")]));
    const data = write(blocks);
    expect(PdfFile.open(data).pages().length).toBeGreaterThan(3);
    const back = read(data);
    expect(back.blocks.length).toBe(80);
    expect(blocksToText([back.blocks[79]!])).toContain("Paragraph 79");
  });

  test("a paragraph broken across pages is read as one", () => {
    const long = "word ".repeat(400) + "end.";
    const data = write([para([str(long)])], {}, { pageSize: "a5" });
    expect(PdfFile.open(data).pages().length).toBeGreaterThan(1);
    const back = read(data);
    expect(back.blocks.length).toBe(1);
    expect(blocksToText(back.blocks)).toBe(long);
  });

  test("underline, strikeout, block quotes, rules and line breaks render as text", () => {
    const data = write([
      para([new Underline({ content: [str("under")] }), str(" "), new Strikeout({ content: [str("struck")] })]),
      new BlockQuote({ content: [para([str("quoted")])] }),
      new HorizontalRule(),
      para([str("one"), new LineBreak(), str("two")]),
    ]);
    expect(textOf(data)).toContain("under struck");
    expect(textOf(data)).toContain("quoted");
    expect(textOf(data)).toContain("one two");
  });
});

describe("PDF round trip", () => {
  test("headings, paragraphs and inline styling", () => {
    const back = roundTrip([
      header(1, [str("Annual Report")]),
      para([str("Sales were "), strong([str("up 12%")]), str(" and "), emph([str("costs")]), str(" fell; see "), link([str("the site")], "https://example.com"), str(".")]),
      header(2, [str("Details")]),
      para([str("Call "), new Code({ text: "run()" }), str(" first.")]),
    ]);
    expect(back.blocks.map((b) => b._tag)).toEqual(["Header", "Para", "Header", "Para"]);
    const [h1, p, h2, p2] = back.blocks as [Block, Block, Block, Block];
    expect(h1._tag === "Header" && h1.level).toBe(1);
    expect(h2._tag === "Header" && h2.level).toBe(2);
    expect(h1._tag === "Header" && h1.content).toEqual([str("Annual Report")]);
    const tags = p._tag === "Para" ? p.content.map((i: Inline) => i._tag) : [];
    expect(tags).toEqual(["Str", "Strong", "Str", "Emph", "Str", "Link", "Str"]);
    if (p._tag === "Para") {
      const l = p.content[5]!;
      expect(l._tag === "Link" && l.target.url).toBe("https://example.com");
    }
    expect(p2._tag === "Para" && p2.content.map((i: Inline) => i._tag)).toEqual(["Str", "Code", "Str"]);
    expect(Pdf.is(back)).toBe(true);
  });

  test("wrapped paragraphs come back whole, with soft breaks", () => {
    const long = "The quick brown fox jumps over the lazy dog. ".repeat(8).trim();
    const back = roundTrip([para([str(long)]), para([str("Second.")])]);
    expect(back.blocks.length).toBe(2);
    expect(back.blocks[0]!._tag === "Para" && back.blocks[0]!.content.some((i: Inline) => i._tag === "SoftBreak")).toBe(true);
    expect(blocksToText([back.blocks[0]!])).toBe(long);
  });

  test("bullet, ordered and nested lists", () => {
    const back = roundTrip([
      bulletList([[plainText("alpha")], [plainText("beta"), bulletList([[plainText("inner")]])], [plainText("gamma")]]),
      orderedList([[plainText("one")], [plainText("two")]]),
    ]);
    expect(back.blocks.map((b) => b._tag)).toEqual(["BulletList", "OrderedList"]);
    const ul = back.blocks[0]!;
    if (ul._tag === "BulletList") {
      expect(ul.items.length).toBe(3);
      expect(ul.items[1]!.map((b) => b._tag)).toEqual(["Plain", "BulletList"]);
    }
    const ol = back.blocks[1]!;
    expect(ol._tag === "OrderedList" && ol.start).toBe(1);
    expect(blocksToText(back.blocks)).toContain("inner");
  });

  test("code blocks keep their line breaks, indentation and blank lines", () => {
    const code = "function f(x) {\n  if (x) {\n    return 1;\n  }\n\n  return 0;\n}";
    const back = roundTrip([para([str("Before")]), codeBlock(code), para([str("After")])]);
    expect(back.blocks.map((b) => b._tag)).toEqual(["Para", "CodeBlock", "Para"]);
    const cb = back.blocks[1]!;
    expect(cb._tag === "CodeBlock" && cb.text).toBe(code);
  });

  test("a hyphen at a line break joins the word", () => {
    // force a break right after "well-"
    const data = write([para([str("x ".repeat(60) + "well-known")])], {}, { pageSize: [200, 400], margin: 20 });
    expect(textOf(data)).toContain("well-known");
  });
});

describe("text extraction", () => {
  test("TJ adjustments: large gaps are spaces, kerning is not", () => {
    const data = onePage("BT /F1 12 Tf 72 700 Td [(Hello) -300 (world) 80 (!)] TJ ET", { Font: pdfDict({ F1: helvetica }) });
    expect(textOf(data)).toBe("Hello world!");
  });

  test("Differences glyph names, ligatures and uniXXXX names", () => {
    const font = pdfDict({
      Type: pdfName("Font"), Subtype: pdfName("Type1"), BaseFont: pdfName("Times-Roman"),
      Encoding: pdfDict({ Type: pdfName("Encoding"), Differences: pdfArray([1, pdfName("fi"), pdfName("uni2603"), pdfName("eacute.sc")]) }),
    });
    expect(textOf(onePage("BT /F1 12 Tf 72 700 Td (\\001nd \\002 caf\\003) Tj ET", { Font: pdfDict({ F1: font }) }))).toBe("ﬁnd ☃ café");
  });

  test("Type 0 fonts: Identity-H with a ToUnicode CMap (bfchar, bfrange, arrays)", () => {
    const cmap = [
      "/CIDInit /ProcSet findresource begin 12 dict begin begincmap",
      "1 begincodespacerange <0000> <FFFF> endcodespacerange",
      "2 beginbfchar <0001> <0048> <0002> <00660069> endbfchar",
      "2 beginbfrange <0010> <0012> <0061> <0020> <0021> [<03B1> <03B2>] endbfrange",
      "endcmap CMapName currentdict /CMap defineresource pop end end",
    ].join("\n");
    const font = pdfDict({
      Type: pdfName("Font"), Subtype: pdfName("Type0"), BaseFont: pdfName("ABCDEF+Test-Bold"), Encoding: pdfName("Identity-H"),
      ToUnicode: pdfStream(pdfDict(), latin1ToBytes(cmap)),
      DescendantFonts: pdfArray([pdfDict({ Type: pdfName("Font"), Subtype: pdfName("CIDFontType2"), DW: 500, W: pdfArray([1, pdfArray([700])]) })]),
    });
    const data = onePage("BT /F1 12 Tf 72 700 Td <0001001000110012000200200021> Tj ET", { Font: pdfDict({ F1: font }) });
    const file = PdfFile.open(data);
    const glyphs = extractPageText(file, file.pages()[0]!).glyphs;
    expect(glyphs.map((g) => g.text).join("")).toBe("Habcfiαβ");
    expect(glyphs[0]!.bold).toBe(true);
    expect(glyphs[0]!.width).toBeCloseTo(8.4); // 700/1000 * 12
  });

  test("/ActualText replaces the glyphs it covers", () => {
    const content = "BT /F1 12 Tf 72 700 Td (A ) Tj /Span << /ActualText (fl) >> BDC (X) Tj EMC (ow) Tj ET";
    expect(textOf(onePage(content, { Font: pdfDict({ F1: helvetica }) }))).toBe("A flow");
  });

  test("text in Form XObjects is extracted, in place", () => {
    const form = pdfStream(
      pdfDict({ Type: pdfName("XObject"), Subtype: pdfName("Form"), BBox: pdfArray([0, 0, 612, 792]), Resources: pdfDict({ Font: pdfDict({ F1: helvetica }) }) }),
      latin1ToBytes("BT /F1 12 Tf 72 680 Td (from a form) Tj ET")
    );
    const content = "BT /F1 12 Tf 72 700 Td (page text) Tj ET /Fm1 Do";
    expect(textOf(onePage(content, { Font: pdfDict({ F1: helvetica }), XObject: pdfDict({ Fm1: form }) }))).toBe("page text from a form");
  });

  test("rotated pages are read upright; rotated text is skipped", () => {
    // on a /Rotate 90 page, text running up the page reads left to right
    const upright = "BT /F1 12 Tf 0 1 -1 0 300 100 Tm (Sideways page) Tj ET";
    expect(textOf(onePage(upright, { Font: pdfDict({ F1: helvetica }) }, { Rotate: 90 }))).toBe("Sideways page");
    const diagonal = "BT /F1 12 Tf 72 700 Td (kept) Tj ET BT /F1 40 Tf 0.7 0.7 -0.7 0.7 200 300 Tm (WATERMARK) Tj ET";
    expect(textOf(onePage(diagonal, { Font: pdfDict({ F1: helvetica }) }))).toBe("kept");
  });

  test("simulated bold (the same text painted twice, offset) is read once", () => {
    const content = "BT /F1 12 Tf 72 700 Td (Bold) Tj ET BT /F1 12 Tf 72.3 700 Td (Bold) Tj ET";
    expect(textOf(onePage(content, { Font: pdfDict({ F1: helvetica }) }))).toBe("Bold");
  });

  test("UTF-16 metadata strings", () => {
    const pdf = new PdfBuilder();
    const pages = pdf.add(pdfDict({ Type: pdfName("Pages"), Kids: pdfArray([]), Count: 0 }));
    const root = pdf.add(pdfDict({ Type: pdfName("Catalog"), Pages: pages }));
    const info = pdf.add(pdfDict({ Title: pdfTextString("Ελληνικά"), Author: pdfString(latin1ToBytes("Plain")) }));
    const back = read(pdf.build({ root, info }));
    expect(back.meta).toEqual({ title: "Ελληνικά", author: "Plain" });
    expect(back.blocks).toEqual([]);
  });
});

describe("real-world files", () => {
  test("LibreOffice: embedded subset fonts, ToUnicode, links, non-Latin scripts", async () => {
    const back = read(await fixture("libreoffice.pdf"));
    expect(back.blocks.map((b) => b._tag)).toEqual(["Header", "Para", "Header", "BulletList", "OrderedList", "Para"]);
    const text = blocksToText(back.blocks);
    expect(text).toContain("LibreOffice Heading");
    expect(text).toContain("Ünïcödé text: Ελληνικά, Русский, 中文.");
    expect(text).toContain("line joining logic is exercised properly");
    const p = back.blocks[1]!;
    expect(p._tag === "Para" && p.content.map((i: Inline) => i._tag)).toEqual(["Str", "Strong", "Str", "Emph", "Str", "Link", "Str"]);
    expect(back.meta.producer).toContain("LibreOffice");
  });

  test("ReportLab: standard fonts, headings, lists and code", async () => {
    const back = read(await fixture("reportlab.pdf"));
    expect(back.meta.title).toBe("ReportLab Test");
    expect(back.blocks.map((b) => b._tag)).toEqual(["Header", "Header", "Para", "Para", "Header", "BulletList", "CodeBlock"]);
    const cb = back.blocks[6]!;
    expect(cb._tag === "CodeBlock" && cb.text).toBe("def f(x):\n    return x * 2");
    expect(blocksToText(back.blocks)).toContain("ligatures: office affluent. Price €5.");
  });
});

describe("PDF nesting limit (#110)", () => {
  test("output nested deeper than maxDepth fails with a LimitExceeded ParseError", () => {
    const pdf = write([bulletList([[plainText("a")], [bulletList([[plainText("b")]])]])]);
    expect(blocksToText(read(pdf).blocks)).toContain("b");
    const error = run(Effect.flip(makePdfReader({ maxDepth: 2 }).read(bytes(pdf))));
    expect(error).toMatchObject({ _tag: "ParseError", format: "pdf", code: "LimitExceeded" });
  });
});
