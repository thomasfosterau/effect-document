import { it } from "@effect/vitest";
import * as Predicate from "effect/Predicate";
import { assert, describe, expect } from "vite-plus/test";
import * as Effect from "effect/Effect";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import {
  type Block,
  blocksToText,
  BlockQuote,
  bulletList,
  bytes,
  DEFAULT_MAX_NESTING_DEPTH,
  codeBlock,
  document,
  OrderedList,
  Quoted,
  emph,
  type FeaturesOf,
  header,
  HorizontalRule,
  type Inline,
  LineBlock,
  link,
  orderedList,
  para,
  plainText,
  str,
  strong,
  table,
  Table,
  Header,
  Span,
  TableCell,
  TableRow,
  trustAs,
} from "@thomasfosterau/effect-document";
import { Docx, makeDocxReader, makeDocxWriter } from "../../../src/ooxml/docx/index.ts";

type DocxF = FeaturesOf<typeof Docx>;
const doc = (blocks: ReadonlyArray<Block>) => trustAs<DocxF>(document(blocks));
const roundtrip = (blocks: ReadonlyArray<Block>) =>
  Effect.gen(function* () {
    return yield* makeDocxReader().read(yield* makeDocxWriter().write(doc(blocks)));
  });

const findInline = (inlines: ReadonlyArray<Inline>, tag: string): Inline | undefined => {
  for (const i of inlines) {
    if (i._tag === tag) return i;
    // a note holds blocks: search the inlines of its paragraphs
    const kids = Predicate.isTagged(i, "Note")
      ? i.content.flatMap(inlinesOf)
      : "content" in i
        ? i.content
        : [];
    const found = findInline(kids, tag);
    if (found) return found;
  }
  return undefined;
};

/** A one-cell table as the reader returns it (no column specs). */
const cellTable = (text: string) =>
  new Table({
    colSpecs: [],
    head: [],
    body: [new TableRow({ cells: [new TableCell({ content: [para([str(text)])] })] })],
    foot: [],
  });

describe("DOCX round-trip", () => {
  it.effect("preserves a heading level", () =>
    Effect.gen(function* () {
      const back = yield* roundtrip([header(3, [str("Section")])]);
      expect(back.blocks[0]).toMatchObject({ _tag: "Header", level: 3 });
    }),
  );

  it.effect("preserves bold / italic runs", () =>
    Effect.gen(function* () {
      const back = yield* roundtrip([para([strong([str("b")]), emph([str("i")])])]);
      const p = back.blocks[0];
      expect(p?._tag).toBe("Para");
      assert(p?._tag === "Para");
      expect(findInline(p.content, "Strong")).toBeDefined();
      expect(findInline(p.content, "Emph")).toBeDefined();
    }),
  );

  it.effect("preserves a hyperlink and its URL", () =>
    Effect.gen(function* () {
      const back = yield* roundtrip([
        para([str("see "), link([str("here")], "https://example.com")]),
      ]);
      const p = back.blocks[0];
      assert(p?._tag === "Para");
      const lnk = p.content.find((i) => Predicate.isTagged(i, "Link"));
      expect(lnk).toMatchObject({ _tag: "Link", target: { url: "https://example.com" } });
    }),
  );

  it.effect("a link reads back without an Underline: its look is the Hyperlink style (#109)", () =>
    Effect.gen(function* () {
      const back = yield* roundtrip([para([link([str("here")], "https://example.com")])]);
      const p = back.blocks[0];
      assert(p?._tag === "Para");
      expect(p.content).toEqual([
        expect.objectContaining({
          _tag: "Link",
          content: [expect.objectContaining({ text: "here" })],
        }),
      ]);
    }),
  );

  it.effect("blocks outside the profile are written best-effort, as their text", () =>
    Effect.gen(function* () {
      const back = yield* roundtrip([
        new HorizontalRule(),
        new BlockQuote({ content: [para([str("quoted")])] }),
        new LineBlock({ lines: [[str("one")], [str("two")]] }),
      ]);
      expect(blocksToText(back.blocks)).toContain("quoted");
      expect(blocksToText(back.blocks)).toContain("two");
    }),
  );

  it.effect("adjacent bullet lists stay two lists (#109)", () =>
    Effect.gen(function* () {
      const back = yield* roundtrip([
        bulletList([[plainText("a")]]),
        bulletList([[plainText("b")]]),
      ]);
      expect(back.blocks.map((b) => b._tag)).toEqual(["BulletList", "BulletList"]);
    }),
  );

  it.effect("a heading that leads a list item keeps its level (#109)", () =>
    Effect.gen(function* () {
      const back = yield* roundtrip([bulletList([[header(2, [str("h")])]])]);
      expect(back.blocks[0]).toMatchObject({
        _tag: "BulletList",
        items: [[{ _tag: "Header", level: 2 }]],
      });
    }),
  );

  it.effect("preserves bullet and ordered lists", () =>
    Effect.gen(function* () {
      const back = yield* roundtrip([
        bulletList([[plainText("a")], [plainText("b")]]),
        orderedList([[plainText("1")], [plainText("2")]]),
      ]);
      expect(back.blocks.map((b) => b._tag)).toEqual(["BulletList", "OrderedList"]);
      const bl = back.blocks[0];
      assert(bl?._tag === "BulletList");
      expect(bl.items).toHaveLength(2);
    }),
  );

  it.effect("preserves a table with a header row", () =>
    Effect.gen(function* () {
      const back = yield* roundtrip([
        table({ headers: ["Name", "Age"], rows: [[[plainText("alice")], [plainText("30")]]] }),
      ]);
      const t = back.blocks[0];
      expect(t?._tag).toBe("Table");
      assert(t?._tag === "Table");
      expect(t.head).toHaveLength(1);
      expect(t.body).toHaveLength(1);
      expect(blocksToText([t])).toContain("Name\tAge");
    }),
  );

  it.effect("output conforms to the DOCX profile", () =>
    Effect.gen(function* () {
      const back = yield* roundtrip([header(1, [str("Hi")]), para([emph([str("x")])])]);
      expect(Docx.is(back)).toBe(true);
    }),
  );
});

/** A paragraph inside `n` nested single-cell tables. */
const nestedTables = (n: number): Block => {
  let b: Block = para([str("x")]);
  for (let i = 0; i < n; i++) b = table({ rows: [[[b]]] });
  return b;
};

/**
 * `depth` nested single-cell tables around a paragraph, built as XML rather
 * than through the (recursive) writer, whose rendering of a very deep
 * document would exhaust Node's stack before the reader is ever reached.
 */
const deepTables = (depth: number) => {
  const W = `xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"`;
  const PKG = "http://schemas.openxmlformats.org/package/2006/relationships";
  const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  const body =
    "<w:tbl><w:tr><w:tc>".repeat(depth) +
    "<w:p><w:r><w:t>x</w:t></w:r></w:p>" +
    "</w:tc></w:tr></w:tbl>".repeat(depth);
  return bytes(
    zipSync({
      "_rels/.rels": strToU8(
        `<Relationships xmlns="${PKG}"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="word/document.xml"/></Relationships>`,
      ),
      "word/document.xml": strToU8(`<w:document ${W}><w:body>${body}</w:body></w:document>`),
    }),
  );
};

/** A DOCX of a paragraph inside `n` nested tables, written by our writer. */
const nestedDocx = (n: number) =>
  Effect.gen(function* () {
    return yield* makeDocxWriter().write(doc([nestedTables(n)]));
  });

describe("DOCX nesting limit (#110)", () => {
  it.effect("tables nested past maxDepth fail with a LimitExceeded ParseError", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        makeDocxReader({ maxDepth: 10 }).read(yield* nestedDocx(10)),
      );
      expect(error).toMatchObject({ _tag: "ParseError", format: "docx", code: "LimitExceeded" });
    }),
  );

  it.effect("tables nested within maxDepth read normally", () =>
    Effect.gen(function* () {
      const back = yield* makeDocxReader({ maxDepth: 10 }).read(yield* nestedDocx(8));
      expect(blocksToText(back.blocks)).toBe("x");
    }),
  );

  it.effect("the default limit refuses very deep nesting", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(makeDocxReader().read(deepTables(1500)));
      expect(error).toMatchObject({ code: "LimitExceeded" });
    }),
  );

  it.effect("nesting exactly at the default limit reads without exhausting the stack", () =>
    Effect.gen(function* () {
      // 998 tables, their innermost paragraph and its text: 1000 levels
      const back = yield* makeDocxReader().read(deepTables(DEFAULT_MAX_NESTING_DEPTH - 2));
      expect(blocksToText(back.blocks)).toBe("x");
    }),
  );
});

/** A run of `text`, with `rPr` as its properties. */
const r = (text: string, rPr = "") =>
  `<w:r><w:rPr>${rPr}</w:rPr><w:t xml:space="preserve">${text}</w:t></w:r>`;
/** A paragraph-like block's inlines (none for any other block). */
const inlinesOf = (b: Block | undefined): ReadonlyArray<Inline> =>
  b !== undefined &&
  (Predicate.isTagged(b, "Para") ||
    Predicate.isTagged(b, "Plain") ||
    Predicate.isTagged(b, "Header"))
    ? b.content
    : [];
/** Write `blocks`, and return a lookup of the package parts' text by path. */
const parts = (blocks: ReadonlyArray<Block>) =>
  Effect.gen(function* () {
    const out = yield* makeDocxWriter().write(doc(blocks));
    assert(Predicate.isTagged(out, "Bytes"), "expected bytes");
    const files = unzipSync(out.bytes);
    return (path: string) => (files[path] === undefined ? undefined : strFromU8(files[path]));
  });
/** A list item of numbering 9 at `ilvl`. */
const numbered9 = (t: string, ilvl: number) =>
  `<w:p><w:pPr><w:numPr><w:ilvl w:val="${ilvl}"/><w:numId w:val="9"/></w:numPr></w:pPr>${r(t)}</w:p>`;
/** A `ListParagraph` item of numbering 4 at `ilvl`. */
const listParagraph4 = (t: string, ilvl: number) =>
  `<w:p><w:pPr><w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="${ilvl}"/><w:numId w:val="4"/></w:numPr></w:pPr>${r(t)}</w:p>`;
/** A `ListParagraph` with no numbering, indented by the `ind` attributes. */
const indented = (t: string, ind: string) =>
  `<w:p><w:pPr><w:pStyle w:val="ListParagraph"/><w:ind ${ind}/></w:pPr>${r(t)}</w:p>`;
/** Bookmark `name` (id `id`) around `inner`. */
const bm = (id: number, name: string, inner: string) =>
  `<w:bookmarkStart w:id="${id}" w:name="${name}"/>${inner}<w:bookmarkEnd w:id="${id}"/>`;

describe("DOCX correctness (#72)", () => {
  const W = `xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"`;
  const PKG = "http://schemas.openxmlformats.org/package/2006/relationships";
  const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

  /** A hand-built package around a `w:body`, with optional numbering and hyperlink rels. */
  const docxWith = (body: string, numbering?: string, rels = "") => {
    const files = {
      "_rels/.rels": strToU8(
        `<Relationships xmlns="${PKG}"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="word/document.xml"/></Relationships>`,
      ),
      "word/document.xml": strToU8(`<w:document ${W}><w:body>${body}</w:body></w:document>`),
      "word/_rels/document.xml.rels": strToU8(
        `<Relationships xmlns="${PKG}">` +
          (numbering === undefined
            ? ""
            : `<Relationship Id="rIdN" Type="${REL}/numbering" Target="numbering.xml"/>`) +
          rels +
          `</Relationships>`,
      ),
    };
    return bytes(
      zipSync(
        numbering === undefined
          ? files
          : {
              ...files,
              "word/numbering.xml": strToU8(`<w:numbering ${W}>${numbering}</w:numbering>`),
            },
      ),
    );
  };
  const read = (body: string, numbering?: string, rels?: string) =>
    Effect.gen(function* () {
      return yield* makeDocxReader().read(docxWith(body, numbering, rels));
    });

  // ---- writer

  it.effect("1. a hyperlink URL with a quote produces a readable package", () =>
    Effect.gen(function* () {
      const url = `https://example.com/?q="x"&y=1`;
      const back = yield* roundtrip([para([link([str("l")], url)])]);
      expect(findInline(inlinesOf(back.blocks[0]), "Link")).toMatchObject({ target: { url } });
    }),
  );

  it.effect("2. separate ordered lists restart, and start round-trips", () =>
    Effect.gen(function* () {
      const back = yield* roundtrip([
        orderedList([[plainText("a")], [plainText("b")]]),
        para([str("between")]),
        new OrderedList({ start: 5, items: [[plainText("c")]] }),
      ]);
      expect(back.blocks.map((b) => b._tag)).toEqual(["OrderedList", "Para", "OrderedList"]);
      expect(back.blocks[0]).toMatchObject({ start: undefined });
      expect(back.blocks[2]).toMatchObject({ start: 5 });
      const numbering = (yield* parts([
        orderedList([[plainText("a")]]),
        orderedList([[plainText("b")]]),
      ]))("word/numbering.xml")!;
      expect(numbering.match(/<w:num w:numId=/g)).toHaveLength(2);
      expect(numbering).toContain(`<w:startOverride w:val="1"/>`);
    }),
  );

  it.effect("3. nested lists and other item blocks are kept", () =>
    Effect.gen(function* () {
      const nested = bulletList([
        [plainText("a"), orderedList([[plainText("a1")], [plainText("a2")]])],
        [plainText("b")],
      ]);
      expect((yield* roundtrip([nested])).blocks).toEqual([nested]);
      const back = yield* roundtrip([bulletList([[plainText("a"), codeBlock("x = 1")]])]);
      expect(blocksToText(back.blocks)).toContain("x = 1");
    }),
  );

  it.effect("an item's blocks after its first paragraph stay in the item (#195)", () =>
    Effect.gen(function* () {
      const lists = [
        bulletList([[plainText("a"), para([str("a, continued")])], [plainText("b")]]),
        orderedList([
          [plainText("one"), codeBlock("x = 1"), cellTable("cell")],
          [plainText("two"), header(2, [str("heading")])],
        ]),
      ];
      expect((yield* roundtrip(lists)).blocks).toEqual(lists);
    }),
  );

  it.effect("an item that starts with a code block, table or list keeps it (#195)", () =>
    Effect.gen(function* () {
      const list = bulletList([
        [codeBlock("first")],
        [cellTable("t"), para([str("after")])],
        [bulletList([[plainText("inner")]]), para([str("outer again")])],
      ]);
      expect((yield* roundtrip([list])).blocks).toEqual([list]);
    }),
  );

  it.effect("a continuation after a nested list returns to its own item (#195)", () =>
    Effect.gen(function* () {
      const list = bulletList([
        [
          plainText("a"),
          orderedList([[plainText("a1"), para([str("a1 more")])]]),
          para([str("a more")]),
        ],
        [plainText("b")],
      ]);
      expect((yield* roundtrip([list, para([str("after the list")])])).blocks).toEqual([
        list,
        para([str("after the list")]),
      ]);
    }),
  );

  it.effect("continuation blocks are indented to their item's level (#195)", () =>
    Effect.gen(function* () {
      const xml = (yield* parts([
        bulletList([[plainText("a"), para([str("p")]), table({ rows: [[[para([str("t")])]]] })]]),
      ]))("word/document.xml");
      expect(xml).toContain(`<w:p><w:pPr><w:ind w:left="720"/></w:pPr>`);
      expect(xml).toContain(`<w:tblInd w:w="720" w:type="dxa"/>`);
    }),
  );

  it.effect("4. Quoted keeps its quotation marks", () =>
    Effect.gen(function* () {
      const back = yield* roundtrip([
        para([
          new Quoted({ quoteType: "double", content: [str("hi")] }),
          new Quoted({ quoteType: "single", content: [str("yo")] }),
        ]),
      ]);
      expect(blocksToText(back.blocks)).toBe("“hi”‘yo’");
    }),
  );

  it.effect("5. newlines and tabs become w:br and w:tab; code blocks round-trip", () =>
    Effect.gen(function* () {
      const xml = (yield* parts([codeBlock("a\n\tb"), para([str("c\nd")])]))("word/document.xml")!;
      expect(xml).toContain("<w:br/>");
      expect(xml).toContain("<w:tab/>");
      expect(xml).not.toMatch(/<w:t[^>]*>[^<]*\n/);
      expect((yield* roundtrip([codeBlock("a\n\tb")])).blocks).toEqual([codeBlock("a\n\tb")]);
    }),
  );

  it.effect("6. a styles part defines the styles the document uses", () =>
    Effect.gen(function* () {
      const get = yield* parts([
        header(1, [str("h")]),
        codeBlock("c"),
        table({ rows: [[[para([str("t")])]]] }),
      ]);
      const styles = get("word/styles.xml")!;
      for (const id of ["Heading1", "Heading6", "Code", "TableGrid"])
        expect(styles).toContain(`w:styleId="${id}"`);
      expect(get("word/_rels/document.xml.rels")).toContain(`Target="styles.xml"`);
      expect(get("[Content_Types].xml")).toContain("/word/styles.xml");
    }),
  );

  // ---- reader

  it.effect("7. explicit off values of toggle properties are off", () =>
    Effect.gen(function* () {
      const back = yield* read(
        `<w:p>${r("a", `<w:b w:val="0"/><w:i w:val="false"/><w:strike w:val="off"/><w:u w:val="none"/>`)}${r("b", `<w:b/><w:u w:val="single"/>`)}</w:p>`,
      );
      const content = inlinesOf(back.blocks[0]);
      expect(content[0]).toMatchObject({ _tag: "Str", text: "a" });
      expect(content[1]!._tag).toBe("Underline");
    }),
  );

  it.effect("8. numId 0 is not a list", () =>
    Effect.gen(function* () {
      const back = yield* read(
        `<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="0"/></w:numPr></w:pPr>${r("x")}</w:p>`,
      );
      expect(back.blocks[0]!._tag).toBe("Para");
    }),
  );

  it.effect("9. the list kind comes from numbering.xml", () =>
    Effect.gen(function* () {
      const numbering =
        `<w:abstractNum w:abstractNumId="7"><w:lvl w:ilvl="0"><w:numFmt w:val="lowerRoman"/></w:lvl><w:lvl w:ilvl="1"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum>` +
        `<w:num w:numId="9"><w:abstractNumId w:val="7"/></w:num>`;
      const back = yield* read(numbered9("i", 0) + numbered9("dot", 1), numbering);
      expect(back.blocks).toEqual([
        orderedList([[plainText("i"), bulletList([[plainText("dot")]])]]),
      ]);
    }),
  );

  it.effect("a paragraph indented to an open list's level continues its last item (#195)", () =>
    Effect.gen(function* () {
      const numbering =
        `<w:abstractNum w:abstractNumId="3"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/><w:pPr><w:ind w:left="360" w:hanging="360"/></w:pPr></w:lvl>` +
        `<w:lvl w:ilvl="1"><w:numFmt w:val="bullet"/><w:pPr><w:ind w:start="1080" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum>` +
        `<w:num w:numId="4"><w:abstractNumId w:val="3"/></w:num>`;
      const back = yield* read(
        listParagraph4("a", 0) +
          listParagraph4("a1", 1) +
          indented("a1 more", `w:left="1080"`) +
          indented("a more", `w:start="360"`) +
          indented("not the list's", `w:left="2000"`),
        numbering,
      );
      expect(back.blocks).toEqual([
        bulletList([
          [
            plainText("a"),
            bulletList([[plainText("a1"), para([str("a1 more")])]]),
            para([str("a more")]),
          ],
        ]),
        para([str("not the list's")]),
      ]);
    }),
  );

  it.effect("10. tracked insertions are kept and deletions dropped", () =>
    Effect.gen(function* () {
      const back = yield* read(
        `<w:p>${r("a")}<w:ins w:id="1">${r("b")}</w:ins><w:del w:id="2"><w:r><w:delText>gone</w:delText></w:r></w:del></w:p>`,
      );
      expect(blocksToText(back.blocks)).toBe("ab");
    }),
  );

  it.effect("11. inline and block content controls are kept", () =>
    Effect.gen(function* () {
      const back = yield* read(
        `<w:sdt><w:sdtPr/><w:sdtContent><w:p>${r("toc")}</w:p></w:sdtContent></w:sdt>` +
          `<w:p>${r("name: ")}<w:sdt><w:sdtContent>${r("Ada")}</w:sdtContent></w:sdt></w:p>`,
      );
      expect(blocksToText(back.blocks)).toBe("toc\nname: Ada");
    }),
  );

  it.effect(
    "12. simple and complex HYPERLINK fields become links; other fields keep their result",
    () =>
      Effect.gen(function* () {
        const back = yield* read(
          `<w:p><w:fldSimple w:instr=" PAGE ">${r("3")}</w:fldSimple>` +
            `<w:fldSimple w:instr='HYPERLINK "https://a.example"'>${r("A")}</w:fldSimple>` +
            `<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> HYPERLINK "https://b.example" </w:instrText></w:r>` +
            `<w:r><w:fldChar w:fldCharType="separate"/></w:r>${r("B")}<w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>`,
        );
        const content = inlinesOf(back.blocks[0]);
        expect(content.map((i) => i._tag)).toEqual(["Str", "Link", "Link"]);
        expect(content[1]).toMatchObject({ target: { url: "https://a.example" } });
        expect(content[2]).toMatchObject({
          target: { url: "https://b.example" },
          content: [{ text: "B" }],
        });
      }),
  );

  it.effect("13. internal hyperlinks become #anchor and round-trip", () =>
    Effect.gen(function* () {
      const back = yield* read(
        `<w:p><w:hyperlink w:anchor="intro">${r("Intro")}</w:hyperlink></w:p>`,
      );
      expect(inlinesOf(back.blocks[0])[0]).toMatchObject({ target: { url: "#intro" } });
      const again = yield* roundtrip([para([link([str("x")], "#intro")])]);
      expect(inlinesOf(again.blocks[0])[0]).toMatchObject({ target: { url: "#intro" } });
    }),
  );

  it.effect("13b. a heading's bookmark is its id, and round-trips with a link to it (#184)", () =>
    Effect.gen(function* () {
      const h = (name: string, text: string) =>
        `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:bookmarkStart w:id="0" w:name="${name}"/>${r(text)}<w:bookmarkEnd w:id="0"/></w:p>`;
      const back = yield* read(
        [
          h("intro", "Intro"),
          // Word's hidden bookmarks: a table of contents' one is kept only when a link goes to it
          h("_Toc123", "Listed"),
          h("_Toc456", "Unlisted"),
          h("_GoBack", "Edited"),
          `<w:p><w:hyperlink w:anchor="_Toc123">${r("see")}</w:hyperlink></w:p>`,
        ].join(""),
      );
      const ids = back.blocks.flatMap((b) => (Predicate.isTagged(b, "Header") ? [b.attr?.id] : []));
      expect(ids).toEqual(["intro", "_Toc123", undefined, undefined]);
      const again = yield* roundtrip([
        new Header({ level: 2, attr: { id: "sec" }, content: [str("Section")] }),
        para([link([str("go")], "#sec")]),
      ]);
      const [heading, p] = again.blocks;
      assert(Predicate.isTagged(heading, "Header"));
      expect(heading.attr).toEqual({ id: "sec" });
      expect(inlinesOf(p)[0]).toMatchObject({ target: { url: "#sec" } });
    }),
  );

  it.effect("13c. other bookmarked text is a span with the bookmark as its id (#184)", () =>
    Effect.gen(function* () {
      const back = yield* read(
        [
          `<w:p>${r("See ")}${bm(1, "here", r("this"))}${r(".")}</w:p>`,
          // an empty bookmark (a place to link to) is an empty span
          `<w:p>${bm(2, "spot", "")}${r("Text")}</w:p>`,
          // a bookmark that runs into the next paragraph covers the rest of this one
          `<w:p>${r("a ")}<w:bookmarkStart w:id="3" w:name="long"/>${r("b")}</w:p>`,
          `<w:p>${r("c")}<w:bookmarkEnd w:id="3"/></w:p>`,
          // a heading's first bookmark is its id; another one is a span in it
          `<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr>${bm(4, "h", r("Head ") + bm(5, "word", r("word")))}</w:p>`,
          // a hidden bookmark no link goes to stays hidden
          `<w:p>${bm(6, "_GoBack", r("x"))}</w:p>`,
          // a bookmark on part of a heading is a span in it, not the heading's id
          `<w:p><w:pPr><w:pStyle w:val="Heading3"/></w:pPr>${r("Intro ")}${bm(7, "part", r("part"))}</w:p>`,
        ].join(""),
      );
      expect(back.blocks).toEqual([
        para([str("See "), new Span({ attr: { id: "here" }, content: [str("this")] }), str(".")]),
        para([new Span({ attr: { id: "spot" }, content: [] }), str("Text")]),
        para([str("a "), new Span({ attr: { id: "long" }, content: [str("b")] })]),
        para([str("c")]),
        new Header({
          level: 2,
          attr: { id: "h" },
          content: [str("Head "), new Span({ attr: { id: "word" }, content: [str("word")] })],
        }),
        para([str("x")]),
        new Header({
          level: 3,
          content: [str("Intro "), new Span({ attr: { id: "part" }, content: [str("part")] })],
        }),
      ]);
    }),
  );

  it.effect("13d. overlapping bookmarks keep the outer one (#184)", () =>
    Effect.gen(function* () {
      const back = yield* read(
        `<w:p><w:bookmarkStart w:id="1" w:name="a"/>${r("one ")}<w:bookmarkStart w:id="2" w:name="b"/>${r("two")}<w:bookmarkEnd w:id="1"/>${r(" three")}<w:bookmarkEnd w:id="2"/></w:p>`,
      );
      expect(back.blocks).toEqual([
        para([new Span({ attr: { id: "a" }, content: [str("one "), str("two")] }), str(" three")]),
      ]);
    }),
  );

  it.effect("13e. a span's id round-trips as a bookmark a link can go to (#184)", () =>
    Effect.gen(function* () {
      const blocks = [
        para([str("Go "), link([str("there")], "#t"), str(".")]),
        para([str("It is "), new Span({ attr: { id: "t" }, content: [strong([str("here")])] })]),
      ];
      const back = yield* roundtrip(blocks);
      expect(back.blocks).toEqual(blocks);
    }),
  );

  it.effect("14. a page break splits the paragraph", () =>
    Effect.gen(function* () {
      const back = yield* read(
        `<w:p>${r("one")}<w:r><w:br w:type="page"/></w:r>${r("two")}<w:r><w:br/></w:r>${r("three")}</w:p>`,
      );
      expect(back.blocks.map((b) => b._tag)).toEqual(["Para", "Para"]);
      expect(blocksToText(back.blocks)).toBe("one\ntwo\nthree");
    }),
  );
});
