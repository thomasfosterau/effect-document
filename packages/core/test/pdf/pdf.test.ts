import { layer } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Predicate from "effect/Predicate";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, expect, test } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import {
  type Block,
  blocksToText,
  bulletList,
  bytes,
  codeBlock,
  document,
  emph,
  header,
  type Inline,
  link,
  type Meta,
  orderedList,
  para,
  plainText,
  str,
  strong,
  trustAs,
} from "@thomasfosterau/effect-document";
import {
  BlockQuote,
  Code,
  HorizontalRule,
  LineBreak,
  Strikeout,
  Underline,
} from "@thomasfosterau/effect-document";
import {
  Pdf,
  type PdfFeature,
  extractPageText,
  makePdfReader,
  makePdfWriter,
} from "../../src/pdf/index.ts";
import {
  PdfBuilder,
  PdfFile,
  type PdfObject,
  bytesToLatin1,
  latin1ToBytes,
  pdfArray,
  pdfDict,
  pdfName,
  pdfStream,
  pdfString,
  pdfTextString,
} from "../../src/pdf/cos/index.ts";

const doc = (blocks: ReadonlyArray<Block>, meta: Meta = {}) =>
  trustAs<PdfFeature>(document(blocks, meta));
const write = (blocks: ReadonlyArray<Block>, meta?: Meta, options = {}) =>
  Effect.gen(function* () {
    const c = yield* makePdfWriter(options).write(doc(blocks, meta));
    assert(Predicate.isTagged(c, "Bytes"), "expected bytes");
    return c.bytes;
  });
const read = (data: Uint8Array) =>
  Effect.gen(function* () {
    return yield* makePdfReader().read(bytes(data));
  });
const roundTrip = (blocks: ReadonlyArray<Block>, meta?: Meta) =>
  Effect.gen(function* () {
    return yield* read(yield* write(blocks, meta));
  });
/** Reads one of the PDFs under `test/fixtures` (provenance: its README). */
const fixture = (name: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* fs.readFile(
      yield* path.fromFileUrl(new URL(`./fixtures/${name}`, import.meta.url)),
    );
  });

/** A one-page PDF with the given content stream and resources. */
const onePage = (
  content: string,
  resources: Record<string, PdfObject>,
  page: Record<string, PdfObject> = {},
): Uint8Array => {
  const pdf = new PdfBuilder();
  const pages = pdf.alloc();
  const contents = pdf.add(pdfStream(pdfDict(), latin1ToBytes(content)));
  const p = pdf.add(
    pdfDict({
      Type: pdfName("Page"),
      Parent: pages,
      MediaBox: pdfArray([0, 0, 612, 792]),
      Contents: contents,
      Resources: pdfDict(resources),
      ...page,
    }),
  );
  pdf.set(pages, pdfDict({ Type: pdfName("Pages"), Kids: pdfArray([p]), Count: 1 }));
  return pdf.build({ root: pdf.add(pdfDict({ Type: pdfName("Catalog"), Pages: pages })) });
};

const helvetica = pdfDict({
  Type: pdfName("Font"),
  Subtype: pdfName("Type1"),
  BaseFont: pdfName("Helvetica"),
  Encoding: pdfName("WinAnsiEncoding"),
});
const textOf = (data: Uint8Array) =>
  Effect.gen(function* () {
    return blocksToText((yield* read(data)).blocks);
  });

layer(NodeServices.layer)((it) => {
  describe("PDF writer", () => {
    it.effect("writes a well-formed PDF with metadata", () =>
      Effect.gen(function* () {
        const data = yield* write([para([str("hello")])], {
          title: "Greeting",
          author: "Ünïcode Author",
        });
        const head = new TextDecoder().decode(data.subarray(0, 8));
        expect(head).toBe("%PDF-1.7");
        expect(new TextDecoder().decode(data.subarray(data.length - 6))).toBe("%%EOF\n");
        const file = PdfFile.open(data);
        expect(file.repaired).toBe(false);
        expect((yield* read(data)).meta).toMatchObject({
          title: "Greeting",
          author: "Ünïcode Author",
          producer: "effect-document",
        });
      }),
    );

    it.effect("page size, margin and compression options", () =>
      Effect.gen(function* () {
        const data = yield* write([para([str("x")])], {}, { pageSize: "letter", compress: false });
        const page = PdfFile.open(data).pages()[0]!;
        expect(page.mediaBox).toEqual([0, 0, 612, 792]);
        expect(bytesToLatin1(data)).toContain("(x) Tj");
        const custom = PdfFile.open(
          yield* write([para([str("x")])], {}, { pageSize: [300, 400] }),
        ).pages()[0]!;
        expect(custom.mediaBox).toEqual([0, 0, 300, 400]);
      }),
    );

    it.effect("characters outside WinAnsiEncoding are written as ?", () =>
      Effect.gen(function* () {
        expect(yield* textOf(yield* write([para([str("Café € “ok” 中")])]))).toBe("Café € “ok” ?");
      }),
    );

    it.effect("long documents flow onto more pages", () =>
      Effect.gen(function* () {
        const blocks = Array.from({ length: 80 }, (_, i) =>
          para([str(`Paragraph ${i} `.repeat(12) + "ends.")]),
        );
        const data = yield* write(blocks);
        expect(PdfFile.open(data).pages().length).toBeGreaterThan(3);
        const back = yield* read(data);
        expect(back.blocks.length).toBe(80);
        expect(blocksToText([back.blocks[79]!])).toContain("Paragraph 79");
      }),
    );

    it.effect("a paragraph broken across pages is read as one", () =>
      Effect.gen(function* () {
        const long = "word ".repeat(400) + "end.";
        const data = yield* write([para([str(long)])], {}, { pageSize: "a5" });
        expect(PdfFile.open(data).pages().length).toBeGreaterThan(1);
        const back = yield* read(data);
        expect(back.blocks.length).toBe(1);
        expect(blocksToText(back.blocks)).toBe(long);
      }),
    );

    it.effect("underline, strikeout, block quotes, rules and line breaks render as text", () =>
      Effect.gen(function* () {
        const data = yield* write([
          para([
            new Underline({ content: [str("under")] }),
            str(" "),
            new Strikeout({ content: [str("struck")] }),
          ]),
          new BlockQuote({ content: [para([str("quoted")])] }),
          new HorizontalRule(),
          para([str("one"), new LineBreak(), str("two")]),
        ]);
        expect(yield* textOf(data)).toContain("under struck");
        expect(yield* textOf(data)).toContain("quoted");
        expect(yield* textOf(data)).toContain("one two");
      }),
    );
  });

  describe("PDF round trip", () => {
    it.effect("headings, paragraphs and inline styling", () =>
      Effect.gen(function* () {
        const back = yield* roundTrip([
          header(1, [str("Annual Report")]),
          para([
            str("Sales were "),
            strong([str("up 12%")]),
            str(" and "),
            emph([str("costs")]),
            str(" fell; see "),
            link([str("the site")], "https://example.com"),
            str("."),
          ]),
          header(2, [str("Details")]),
          para([str("Call "), new Code({ text: "run()" }), str(" first.")]),
        ]);
        expect(back.blocks.map((b) => b._tag)).toEqual(["Header", "Para", "Header", "Para"]);
        const [h1, p, h2, p2] = back.blocks;
        expect(Predicate.isTagged(h1, "Header") && h1.level).toBe(1);
        expect(Predicate.isTagged(h2, "Header") && h2.level).toBe(2);
        expect(Predicate.isTagged(h1, "Header") && h1.content).toEqual([str("Annual Report")]);
        const tags = Predicate.isTagged(p, "Para") ? p.content.map((i: Inline) => i._tag) : [];
        expect(tags).toEqual(["Str", "Strong", "Str", "Emph", "Str", "Link", "Str"]);
        assert(Predicate.isTagged(p, "Para"));
        const l = p.content[5]!;
        expect(Predicate.isTagged(l, "Link") && l.target.url).toBe("https://example.com");
        expect(Predicate.isTagged(p2, "Para") && p2.content.map((i: Inline) => i._tag)).toEqual([
          "Str",
          "Code",
          "Str",
        ]);
        expect(Pdf.is(back)).toBe(true);
      }),
    );

    it.effect("wrapped paragraphs come back whole, with soft breaks", () =>
      Effect.gen(function* () {
        const long = "The quick brown fox jumps over the lazy dog. ".repeat(8).trim();
        const back = yield* roundTrip([para([str(long)]), para([str("Second.")])]);
        expect(back.blocks.length).toBe(2);
        expect(
          back.blocks[0]!._tag === "Para" &&
            back.blocks[0].content.some((i: Inline) => Predicate.isTagged(i, "SoftBreak")),
        ).toBe(true);
        expect(blocksToText([back.blocks[0]!])).toBe(long);
      }),
    );

    it.effect("bullet, ordered and nested lists", () =>
      Effect.gen(function* () {
        const back = yield* roundTrip([
          bulletList([
            [plainText("alpha")],
            [plainText("beta"), bulletList([[plainText("inner")]])],
            [plainText("gamma")],
          ]),
          orderedList([[plainText("one")], [plainText("two")]]),
        ]);
        expect(back.blocks.map((b) => b._tag)).toEqual(["BulletList", "OrderedList"]);
        const ul = back.blocks[0]!;
        assert(Predicate.isTagged(ul, "BulletList"));
        expect(ul.items.length).toBe(3);
        expect(ul.items[1]!.map((b) => b._tag)).toEqual(["Plain", "BulletList"]);
        const ol = back.blocks[1]!;
        expect(Predicate.isTagged(ol, "OrderedList") && ol.start).toBe(1);
        expect(blocksToText(back.blocks)).toContain("inner");
      }),
    );

    it.effect("code blocks keep their line breaks, indentation and blank lines", () =>
      Effect.gen(function* () {
        const code = "function f(x) {\n  if (x) {\n    return 1;\n  }\n\n  return 0;\n}";
        const back = yield* roundTrip([
          para([str("Before")]),
          codeBlock(code),
          para([str("After")]),
        ]);
        expect(back.blocks.map((b) => b._tag)).toEqual(["Para", "CodeBlock", "Para"]);
        const cb = back.blocks[1]!;
        expect(Predicate.isTagged(cb, "CodeBlock") && cb.text).toBe(code);
      }),
    );

    it.effect("a hyphen at a line break joins the word", () =>
      Effect.gen(function* () {
        // force a break right after "well-"
        const data = yield* write(
          [para([str("x ".repeat(60) + "well-known")])],
          {},
          { pageSize: [200, 400], margin: 20 },
        );
        expect(yield* textOf(data)).toContain("well-known");
      }),
    );

    it.effect("a tagged line ending in a plain hyphen keeps the space after it (#198)", () =>
      Effect.gen(function* () {
        // every line ends in "a-", and the writer wraps only at spaces
        const text = Arr.makeBy(80, () => "a-").join(" ");
        const back = yield* roundTrip([para([str(text)])]);
        expect(back.blocks.map((b) => b._tag)).toEqual(["Para"]);
        expect(blocksToText(back.blocks).replace(/\s+/g, " ").trim()).toBe(text);
      }),
    );
  });

  describe("text extraction", () => {
    it.effect("TJ adjustments: large gaps are spaces, kerning is not", () =>
      Effect.gen(function* () {
        const data = onePage("BT /F1 12 Tf 72 700 Td [(Hello) -300 (world) 80 (!)] TJ ET", {
          Font: pdfDict({ F1: helvetica }),
        });
        expect(yield* textOf(data)).toBe("Hello world!");
      }),
    );

    it.effect("Differences glyph names, ligatures and uniXXXX names", () =>
      Effect.gen(function* () {
        const font = pdfDict({
          Type: pdfName("Font"),
          Subtype: pdfName("Type1"),
          BaseFont: pdfName("Times-Roman"),
          Encoding: pdfDict({
            Type: pdfName("Encoding"),
            Differences: pdfArray([1, pdfName("fi"), pdfName("uni2603"), pdfName("eacute.sc")]),
          }),
        });
        expect(
          yield* textOf(
            onePage("BT /F1 12 Tf 72 700 Td (\\001nd \\002 caf\\003) Tj ET", {
              Font: pdfDict({ F1: font }),
            }),
          ),
        ).toBe("ﬁnd ☃ café");
      }),
    );

    test("Type 0 fonts: Identity-H with a ToUnicode CMap (bfchar, bfrange, arrays)", () => {
      const cmap = [
        "/CIDInit /ProcSet findresource begin 12 dict begin begincmap",
        "1 begincodespacerange <0000> <FFFF> endcodespacerange",
        "2 beginbfchar <0001> <0048> <0002> <00660069> endbfchar",
        "2 beginbfrange <0010> <0012> <0061> <0020> <0021> [<03B1> <03B2>] endbfrange",
        "endcmap CMapName currentdict /CMap defineresource pop end end",
      ].join("\n");
      const font = pdfDict({
        Type: pdfName("Font"),
        Subtype: pdfName("Type0"),
        BaseFont: pdfName("ABCDEF+Test-Bold"),
        Encoding: pdfName("Identity-H"),
        ToUnicode: pdfStream(pdfDict(), latin1ToBytes(cmap)),
        DescendantFonts: pdfArray([
          pdfDict({
            Type: pdfName("Font"),
            Subtype: pdfName("CIDFontType2"),
            DW: 500,
            W: pdfArray([1, pdfArray([700])]),
          }),
        ]),
      });
      const data = onePage("BT /F1 12 Tf 72 700 Td <0001001000110012000200200021> Tj ET", {
        Font: pdfDict({ F1: font }),
      });
      const file = PdfFile.open(data);
      const glyphs = extractPageText(file, file.pages()[0]!).glyphs;
      expect(glyphs.map((g) => g.text).join("")).toBe("Habcfiαβ");
      expect(glyphs[0]!.bold).toBe(true);
      expect(glyphs[0]!.width).toBeCloseTo(8.4); // 700/1000 * 12
    });

    it.effect("/ActualText replaces the glyphs it covers", () =>
      Effect.gen(function* () {
        const content =
          "BT /F1 12 Tf 72 700 Td (A ) Tj /Span << /ActualText (fl) >> BDC (X) Tj EMC (ow) Tj ET";
        expect(yield* textOf(onePage(content, { Font: pdfDict({ F1: helvetica }) }))).toBe(
          "A flow",
        );
      }),
    );

    it.effect("text in Form XObjects is extracted, in place", () =>
      Effect.gen(function* () {
        const form = pdfStream(
          pdfDict({
            Type: pdfName("XObject"),
            Subtype: pdfName("Form"),
            BBox: pdfArray([0, 0, 612, 792]),
            Resources: pdfDict({ Font: pdfDict({ F1: helvetica }) }),
          }),
          latin1ToBytes("BT /F1 12 Tf 72 680 Td (from a form) Tj ET"),
        );
        const content = "BT /F1 12 Tf 72 700 Td (page text) Tj ET /Fm1 Do";
        expect(
          yield* textOf(
            onePage(content, { Font: pdfDict({ F1: helvetica }), XObject: pdfDict({ Fm1: form }) }),
          ),
        ).toBe("page text from a form");
      }),
    );

    it.effect("rotated pages are read upright; rotated text is skipped", () =>
      Effect.gen(function* () {
        // on a /Rotate 90 page, text running up the page reads left to right
        const upright = "BT /F1 12 Tf 0 1 -1 0 300 100 Tm (Sideways page) Tj ET";
        expect(
          yield* textOf(onePage(upright, { Font: pdfDict({ F1: helvetica }) }, { Rotate: 90 })),
        ).toBe("Sideways page");
        const diagonal =
          "BT /F1 12 Tf 72 700 Td (kept) Tj ET BT /F1 40 Tf 0.7 0.7 -0.7 0.7 200 300 Tm (WATERMARK) Tj ET";
        expect(yield* textOf(onePage(diagonal, { Font: pdfDict({ F1: helvetica }) }))).toBe("kept");
      }),
    );

    it.effect("simulated bold (the same text painted twice, offset) is read once", () =>
      Effect.gen(function* () {
        const content = "BT /F1 12 Tf 72 700 Td (Bold) Tj ET BT /F1 12 Tf 72.3 700 Td (Bold) Tj ET";
        expect(yield* textOf(onePage(content, { Font: pdfDict({ F1: helvetica }) }))).toBe("Bold");
      }),
    );

    it.effect("UTF-16 metadata strings", () =>
      Effect.gen(function* () {
        const pdf = new PdfBuilder();
        const pages = pdf.add(pdfDict({ Type: pdfName("Pages"), Kids: pdfArray([]), Count: 0 }));
        const root = pdf.add(pdfDict({ Type: pdfName("Catalog"), Pages: pages }));
        const info = pdf.add(
          pdfDict({ Title: pdfTextString("Ελληνικά"), Author: pdfString(latin1ToBytes("Plain")) }),
        );
        const back = yield* read(pdf.build({ root, info }));
        expect(back.meta).toEqual({ title: "Ελληνικά", author: "Plain" });
        expect(back.blocks).toEqual([]);
      }),
    );
  });

  describe("real-world files", () => {
    it.effect("LibreOffice: embedded subset fonts, ToUnicode, links, non-Latin scripts", () =>
      Effect.gen(function* () {
        const back = yield* read(yield* fixture("libreoffice.pdf"));
        expect(back.blocks.map((b) => b._tag)).toEqual([
          "Header",
          "Para",
          "Header",
          "BulletList",
          "OrderedList",
          "Para",
        ]);
        const text = blocksToText(back.blocks);
        expect(text).toContain("LibreOffice Heading");
        expect(text).toContain("Ünïcödé text: Ελληνικά, Русский, 中文.");
        expect(text).toContain("line joining logic is exercised properly");
        const p = back.blocks[1]!;
        expect(Predicate.isTagged(p, "Para") && p.content.map((i: Inline) => i._tag)).toEqual([
          "Str",
          "Strong",
          "Str",
          "Emph",
          "Str",
          "Link",
          "Str",
        ]);
        expect(back.meta.producer).toContain("LibreOffice");
      }),
    );

    it.effect("ReportLab: standard fonts, headings, lists and code", () =>
      Effect.gen(function* () {
        const back = yield* read(yield* fixture("reportlab.pdf"));
        expect(back.meta.title).toBe("ReportLab Test");
        expect(back.blocks.map((b) => b._tag)).toEqual([
          "Header",
          "Header",
          "Para",
          "Para",
          "Header",
          "BulletList",
          "CodeBlock",
        ]);
        const cb = back.blocks[6]!;
        expect(Predicate.isTagged(cb, "CodeBlock") && cb.text).toBe("def f(x):\n    return x * 2");
        expect(blocksToText(back.blocks)).toContain("ligatures: office affluent. Price €5.");
      }),
    );
  });

  describe("PDF nesting limit (#110)", () => {
    it.effect("output nested deeper than maxDepth fails with a LimitExceeded ParseError", () =>
      Effect.gen(function* () {
        const pdf = yield* write([
          bulletList([[plainText("a")], [bulletList([[plainText("b")]])]]),
        ]);
        expect(blocksToText((yield* read(pdf)).blocks)).toContain("b");
        const error = yield* Effect.flip(makePdfReader({ maxDepth: 2 }).read(bytes(pdf)));
        expect(error).toMatchObject({ _tag: "ParseError", format: "pdf", code: "LimitExceeded" });
      }),
    );

    it.effect("deeply nested arrays in a content stream fail with a LimitExceeded ParseError", () =>
      Effect.gen(function* () {
        const pdf = onePage(
          "BT /F1 12 Tf 72 700 Td (kept) Tj ET " + "[".repeat(20_000) + "]".repeat(20_000) + " TJ",
          { Font: pdfDict({ F1: helvetica }) },
        );
        const error = yield* Effect.flip(makePdfReader().read(bytes(pdf)));
        expect(error).toMatchObject({ _tag: "ParseError", format: "pdf", code: "LimitExceeded" });
      }),
    );
  });

  describe("PDF paragraph separation", () => {
    it.effect("one-line paragraphs stay separate paragraphs", () =>
      Effect.gen(function* () {
        yield* Effect.forEach(
          [
            ["First para.", "Second para."],
            ["Intro text.", "x", "Outro text."],
          ],
          (texts) =>
            Effect.map(roundTrip(texts.map((t) => para([str(t)]))), (back) => {
              expect(back.blocks.map((b) => b._tag)).toEqual(texts.map(() => "Para"));
              expect(blocksToText(back.blocks)).toBe(texts.join("\n"));
            }),
          { concurrency: 1, discard: true },
        );
      }),
    );

    it.effect("a mix of one-line and wrapped paragraphs keeps every boundary", () =>
      Effect.gen(function* () {
        const texts = [
          "Short.",
          "Long ".repeat(40) + "end.",
          "Also short.",
          "Another ".repeat(30) + "end.",
        ];
        const back = yield* roundTrip(texts.map((t) => para([str(t)])));
        expect(back.blocks).toHaveLength(4);
      }),
    );
  });
});
