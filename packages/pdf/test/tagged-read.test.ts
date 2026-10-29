/**
 * Reading a tagged PDF's structure tree (#198): the reader takes headings,
 * paragraphs, lists, code and quotes from the tags when the tree owns the
 * text, and falls back to the layout when it doesn't.
 */

import * as Predicate from "effect/Predicate";
import * as Effect from "effect/Effect";
import { assert, describe, expect, test } from "vite-plus/test";
import {
  type Block,
  BlockQuote,
  bulletList,
  bytes,
  codeBlock,
  document,
  header,
  OrderedList,
  orderedList,
  para,
  plainText,
  str,
  trustAs,
} from "@thomasfosterau/effect-document";
import { type PdfFeature, makePdfReader, makePdfWriter } from "../src/index.ts";
import {
  PdfBuilder,
  type PdfObject,
  latin1ToBytes,
  pdfArray,
  pdfDict,
  pdfName,
  pdfStream,
} from "../src/cos/index.ts";

const read = (data: Uint8Array) => Effect.runSync(makePdfReader().read(bytes(data)));

const roundTrip = (blocks: ReadonlyArray<Block>): ReadonlyArray<Block> => {
  const c = Effect.runSync(makePdfWriter().write(trustAs<PdfFeature>(document(blocks))));
  assert(Predicate.isTagged(c, "Bytes"));
  return read(c.bytes).blocks;
};

const tags = (blocks: ReadonlyArray<Block>): ReadonlyArray<string> => blocks.map((b) => b._tag);

describe("reading a tagged PDF's structure (#198)", () => {
  test("headings keep their levels, with no body text to compare their sizes with", () => {
    const back = roundTrip([header(2, [str("Two")]), header(4, [str("Four")])]);
    expect(back.map((b) => (Predicate.isTagged(b, "Header") ? b.level : 0))).toEqual([2, 4]);
  });

  test("one-line paragraphs and adjacent code blocks stay apart", () => {
    const back = roundTrip([
      para([str("one")]),
      para([str("two")]),
      codeBlock("a = 1"),
      codeBlock("b = 2"),
    ]);
    expect(tags(back)).toEqual(["Para", "Para", "CodeBlock", "CodeBlock"]);
  });

  test("a paragraph that starts like a list marker stays a paragraph", () => {
    const back = roundTrip([para([str("a. not a list")]), para([str("iv) nor this")])]);
    expect(tags(back)).toEqual(["Para", "Para"]);
  });

  test("adjacent lists of one kind stay apart, and items keep their paragraphs", () => {
    const back = roundTrip([
      bulletList([[plainText("a")]]),
      bulletList([[plainText("b")]]),
      orderedList([[para([str("first")]), para([str("second")])]]),
      new BlockQuote({ content: [para([str("q")])] }),
    ]);
    expect(tags(back)).toEqual(["BulletList", "BulletList", "OrderedList", "BlockQuote"]);
    const ordered = back[2];
    assert(ordered instanceof OrderedList);
    expect(ordered.items[0]?.map((b) => b._tag)).toEqual(["Plain", "Para"]);
  });

  test("an ordered list keeps its start", () => {
    const back = roundTrip([new OrderedList({ start: 4, items: [[plainText("x")]] })]);
    const list = back[0];
    assert(list instanceof OrderedList);
    expect(list.start).toBe(4);
  });
});

/**
 * A one-page tagged PDF: `content` shows text in marked-content sequences,
 * and `tree(page)` builds the structure tree's root kids.
 */
const tagged = (
  content: string,
  tree: (pdf: PdfBuilder, page: PdfObject, parent: PdfObject) => PdfObject[],
  roleMap: Record<string, string> = {},
): Uint8Array => {
  const pdf = new PdfBuilder();
  const pages = pdf.alloc();
  const page = pdf.alloc();
  const root = pdf.alloc();
  const font = pdf.add(
    pdfDict({
      Type: pdfName("Font"),
      Subtype: pdfName("Type1"),
      BaseFont: pdfName("Helvetica"),
      Encoding: pdfName("WinAnsiEncoding"),
    }),
  );
  pdf.set(
    page,
    pdfDict({
      Type: pdfName("Page"),
      Parent: pages,
      MediaBox: pdfArray([0, 0, 612, 792]),
      Contents: pdf.add(pdfStream(pdfDict(), latin1ToBytes(content))),
      Resources: pdfDict({ Font: pdfDict({ F: font }) }),
    }),
  );
  pdf.set(pages, pdfDict({ Type: pdfName("Pages"), Kids: pdfArray([page]), Count: 1 }));
  pdf.set(
    root,
    pdfDict({
      Type: pdfName("StructTreeRoot"),
      K: pdfArray(tree(pdf, page, root)),
      RoleMap: pdfDict(
        Object.fromEntries(Object.entries(roleMap).map(([k, v]) => [k, pdfName(v)])),
      ),
    }),
  );
  const catalog = pdf.add(
    pdfDict({
      Type: pdfName("Catalog"),
      Pages: pages,
      StructTreeRoot: root,
      MarkInfo: pdfDict({ Marked: true }),
    }),
  );
  return pdf.build({ root: catalog });
};

/** A line of text at `y`, in marked content `mcid` tagged `tag`. */
const line = (tag: string, mcid: number, y: number, text: string, size = 11): string =>
  `/${tag} <</MCID ${mcid}>> BDC BT /F ${size} Tf 72 ${y} Td (${text}) Tj ET EMC`;

const elem = (pdf: PdfBuilder, type: string, page: PdfObject, parent: PdfObject, k: PdfObject) =>
  pdf.add(pdfDict({ Type: pdfName("StructElem"), S: pdfName(type), P: parent, Pg: page, K: k }));

describe("reading other generators' tags (#198)", () => {
  test("custom types go through the role map", () => {
    const data = tagged(
      [line("Title", 0, 700, "Big"), line("Body", 1, 680, "Text")].join("\n"),
      (pdf, page, parent) => [
        elem(pdf, "MyHeading", page, parent, 0),
        elem(pdf, "Body", page, parent, 1),
      ],
      { MyHeading: "H3", Body: "P" },
    );
    const back = read(data).blocks;
    expect(tags(back)).toEqual(["Header", "Para"]);
    expect(Predicate.isTagged(back[0], "Header") && back[0].level).toBe(3);
  });

  test("a tree that owns too little of the text is ignored for the layout", () => {
    // the heading (set larger) is untagged, so the tree can't be trusted
    const data = tagged(
      [
        `BT /F 20 Tf 72 700 Td (A heading set large) Tj ET`,
        line("P", 0, 670, "Body text, long enough to be the most common size."),
      ].join("\n"),
      (pdf, page, parent) => [elem(pdf, "P", page, parent, 0)],
    );
    const back = read(data).blocks;
    expect(tags(back)).toEqual(["Header", "Para"]);
  });

  test("a structure tree with a cycle is ignored for the layout", () => {
    const data = tagged(line("P", 0, 700, "Text"), (pdf, page, parent) => {
      const a = pdf.alloc();
      pdf.set(
        a,
        pdfDict({
          Type: pdfName("StructElem"),
          S: pdfName("Div"),
          P: parent,
          Pg: page,
          K: pdfArray([0, a]),
        }),
      );
      return [a];
    });
    expect(tags(read(data).blocks)).toEqual(["Para"]);
  });

  test("artifacts are not content", () => {
    const data = tagged(
      [line("P", 0, 700, "Text"), "/Artifact BMC BT /F 9 Tf 300 30 Td (Page 1) Tj ET EMC"].join(
        "\n",
      ),
      (pdf, page, parent) => [elem(pdf, "P", page, parent, 0)],
    );
    const back = read(data).blocks;
    expect(back).toHaveLength(1);
    const p = back[0];
    assert(Predicate.isTagged(p, "Para"));
    expect(p.content).toEqual([str("Text")]);
  });

  test("a list reads as bulleted or ordered from its labels when it has no numbering attribute", () => {
    const data = tagged(
      [
        line("Lbl", 0, 700, "1."),
        line("P", 1, 700, "x"),
        line("Lbl", 2, 680, "2."),
        line("P", 3, 680, "y"),
      ].join("\n"),
      (pdf, page, parent) => {
        const l = pdf.alloc();
        const item = (lbl: number, body: number): PdfObject => {
          const li = pdf.alloc();
          const body_ = pdf.alloc();
          pdf.set(
            body_,
            pdfDict({
              Type: pdfName("StructElem"),
              S: pdfName("LBody"),
              P: li,
              Pg: page,
              K: pdfArray([elem(pdf, "P", page, body_, body)]),
            }),
          );
          pdf.set(
            li,
            pdfDict({
              Type: pdfName("StructElem"),
              S: pdfName("LI"),
              P: l,
              Pg: page,
              K: pdfArray([elem(pdf, "Lbl", page, li, lbl), body_]),
            }),
          );
          return li;
        };
        pdf.set(
          l,
          pdfDict({
            Type: pdfName("StructElem"),
            S: pdfName("L"),
            P: parent,
            Pg: page,
            K: pdfArray([item(0, 1), item(2, 3)]),
          }),
        );
        return [l];
      },
    );
    const back = read(data).blocks;
    expect(tags(back)).toEqual(["OrderedList"]);
    const list = back[0];
    assert(list instanceof OrderedList);
    expect(list.items.length).toBe(2);
    expect(list.items[0]).toEqual([plainText("x")]);
  });
});
