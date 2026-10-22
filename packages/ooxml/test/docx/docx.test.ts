import * as Predicate from "effect/Predicate";
import { assert, describe, expect, test } from "vite-plus/test";
import * as Effect from "effect/Effect";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import {
  type Block,
  blocksToText,
  bulletList,
  bytes,
  codeBlock,
  document,
  OrderedList,
  Quoted,
  emph,
  type FeaturesOf,
  header,
  type Inline,
  link,
  orderedList,
  para,
  plainText,
  str,
  strong,
  table,
  trustAs,
} from "@thomasfosterau/effect-document";
import { Docx, makeDocxReader, makeDocxWriter } from "../../src/docx/index.ts";

const run = <A, E>(e: Effect.Effect<A, E>): A => Effect.runSync(e);
type DocxF = FeaturesOf<typeof Docx>;
const doc = (blocks: ReadonlyArray<Block>) => trustAs<DocxF>(document(blocks));
const roundtrip = (blocks: ReadonlyArray<Block>) =>
  run(makeDocxReader().read(run(makeDocxWriter().write(doc(blocks)))));

const findInline = (inlines: ReadonlyArray<Inline>, tag: string): Inline | undefined => {
  for (const i of inlines) {
    if (i._tag === tag) return i;
    if ("content" in i) {
      const found = findInline((i as { content: ReadonlyArray<Inline> }).content, tag);
      if (found) return found;
    }
  }
  return undefined;
};

describe("DOCX round-trip", () => {
  test("preserves a heading level", () => {
    const back = roundtrip([header(3, [str("Section")])]);
    expect(back.blocks[0]).toMatchObject({ _tag: "Header", level: 3 });
  });

  test("preserves bold / italic runs", () => {
    const back = roundtrip([para([strong([str("b")]), emph([str("i")])])]);
    const p = back.blocks[0];
    expect(p?._tag).toBe("Para");
    assert(p?._tag === "Para");
    expect(findInline(p.content, "Strong")).toBeDefined();
    expect(findInline(p.content, "Emph")).toBeDefined();
  });

  test("preserves a hyperlink and its URL", () => {
    const back = roundtrip([para([str("see "), link([str("here")], "https://example.com")])]);
    const p = back.blocks[0];
    assert(p?._tag === "Para");
    const lnk = p.content.find((i) => Predicate.isTagged(i, "Link"));
    expect(lnk).toMatchObject({ _tag: "Link", target: { url: "https://example.com" } });
  });

  test("preserves bullet and ordered lists", () => {
    const back = roundtrip([
      bulletList([[plainText("a")], [plainText("b")]]),
      orderedList([[plainText("1")], [plainText("2")]]),
    ]);
    expect(back.blocks.map((b) => b._tag)).toEqual(["BulletList", "OrderedList"]);
    const bl = back.blocks[0];
    assert(bl?._tag === "BulletList");
    expect(bl.items).toHaveLength(2);
  });

  test("preserves a table with a header row", () => {
    const back = roundtrip([
      table({ headers: ["Name", "Age"], rows: [[[plainText("alice")], [plainText("30")]]] }),
    ]);
    const t = back.blocks[0];
    expect(t?._tag).toBe("Table");
    assert(t?._tag === "Table");
    expect(t.head).toHaveLength(1);
    expect(t.body).toHaveLength(1);
    expect(blocksToText([t])).toContain("Name\tAge");
  });

  test("output conforms to the DOCX profile", () => {
    const back = roundtrip([header(1, [str("Hi")]), para([emph([str("x")])])]);
    expect(Docx.is(back)).toBe(true);
  });
});

describe("DOCX nesting limit (#110)", () => {
  /** A paragraph inside `n` nested single-cell tables. */
  const nestedTables = (n: number): Block => {
    let b: Block = para([str("x")]);
    for (let i = 0; i < n; i++) b = table({ rows: [[[b]]] });
    return b;
  };
  const docx = (n: number) => run(makeDocxWriter().write(doc([nestedTables(n)])));

  test("tables nested past maxDepth fail with a LimitExceeded ParseError", () => {
    const error = run(Effect.flip(makeDocxReader({ maxDepth: 10 }).read(docx(10))));
    expect(error).toMatchObject({ _tag: "ParseError", format: "docx", code: "LimitExceeded" });
  });

  test("tables nested within maxDepth read normally", () => {
    const back = run(makeDocxReader({ maxDepth: 10 }).read(docx(8)));
    expect(blocksToText(back.blocks)).toBe("x");
  });

  test("the default limit refuses very deep nesting", () => {
    // built as XML, not through the (recursive) writer, whose 1500-deep
    // rendering would exhaust Node's stack before the reader is ever reached
    const W = `xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"`;
    const PKG = "http://schemas.openxmlformats.org/package/2006/relationships";
    const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
    const depth = 1500;
    const body =
      "<w:tbl><w:tr><w:tc>".repeat(depth) +
      "<w:p><w:r><w:t>x</w:t></w:r></w:p>" +
      "</w:tc></w:tr></w:tbl>".repeat(depth);
    const deep = zipSync({
      "_rels/.rels": strToU8(
        `<Relationships xmlns="${PKG}"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="word/document.xml"/></Relationships>`,
      ),
      "word/document.xml": strToU8(`<w:document ${W}><w:body>${body}</w:body></w:document>`),
    });
    const error = run(Effect.flip(makeDocxReader().read(bytes(deep))));
    expect(error).toMatchObject({ code: "LimitExceeded" });
  });
});

describe("DOCX correctness (#72)", () => {
  const W = `xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"`;
  const PKG = "http://schemas.openxmlformats.org/package/2006/relationships";
  const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

  /** A hand-built package around a `w:body`, with optional numbering and hyperlink rels. */
  const docxWith = (body: string, numbering?: string, rels = "") => {
    const files: Record<string, Uint8Array> = {
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
    if (numbering !== undefined)
      files["word/numbering.xml"] = strToU8(`<w:numbering ${W}>${numbering}</w:numbering>`);
    return bytes(zipSync(files));
  };
  const read = (body: string, numbering?: string, rels?: string) =>
    run(makeDocxReader().read(docxWith(body, numbering, rels)));
  const r = (text: string, rPr = "") =>
    `<w:r><w:rPr>${rPr}</w:rPr><w:t xml:space="preserve">${text}</w:t></w:r>`;
  const inlinesOf = (b: Block | undefined): ReadonlyArray<Inline> =>
    b !== undefined &&
    (Predicate.isTagged(b, "Para") ||
      Predicate.isTagged(b, "Plain") ||
      Predicate.isTagged(b, "Header"))
      ? b.content
      : [];
  const parts = (blocks: ReadonlyArray<Block>) => {
    const out = run(makeDocxWriter().write(doc(blocks)));
    if (!Predicate.isTagged(out, "Bytes")) throw new Error("expected bytes");
    const files = unzipSync(out.bytes);
    return (path: string) => (files[path] === undefined ? undefined : strFromU8(files[path]!));
  };

  // ---- writer

  test("1. a hyperlink URL with a quote produces a readable package", () => {
    const url = `https://example.com/?q="x"&y=1`;
    const back = roundtrip([para([link([str("l")], url)])]);
    expect(findInline(inlinesOf(back.blocks[0]), "Link")).toMatchObject({ target: { url } });
  });

  test("2. separate ordered lists restart, and start round-trips", () => {
    const back = roundtrip([
      orderedList([[plainText("a")], [plainText("b")]]),
      para([str("between")]),
      new OrderedList({ start: 5, items: [[plainText("c")]] }),
    ]);
    expect(back.blocks.map((b) => b._tag)).toEqual(["OrderedList", "Para", "OrderedList"]);
    expect(back.blocks[0]).toMatchObject({ start: undefined });
    expect(back.blocks[2]).toMatchObject({ start: 5 });
    const numbering = parts([orderedList([[plainText("a")]]), orderedList([[plainText("b")]])])(
      "word/numbering.xml",
    )!;
    expect(numbering.match(/<w:num w:numId=/g)).toHaveLength(3);
    expect(numbering).toContain(`<w:startOverride w:val="1"/>`);
  });

  test("3. nested lists and other item blocks are kept", () => {
    const nested = bulletList([
      [plainText("a"), orderedList([[plainText("a1")], [plainText("a2")]])],
      [plainText("b")],
    ]);
    expect(roundtrip([nested]).blocks).toEqual([nested]);
    const back = roundtrip([bulletList([[plainText("a"), codeBlock("x = 1")]])]);
    expect(blocksToText(back.blocks)).toContain("x = 1");
  });

  test("4. Quoted keeps its quotation marks", () => {
    const back = roundtrip([
      para([
        new Quoted({ quoteType: "double", content: [str("hi")] }),
        new Quoted({ quoteType: "single", content: [str("yo")] }),
      ]),
    ]);
    expect(blocksToText(back.blocks)).toBe("“hi”‘yo’");
  });

  test("5. newlines and tabs become w:br and w:tab; code blocks round-trip", () => {
    const xml = parts([codeBlock("a\n\tb"), para([str("c\nd")])])("word/document.xml")!;
    expect(xml).toContain("<w:br/>");
    expect(xml).toContain("<w:tab/>");
    expect(xml).not.toMatch(/<w:t[^>]*>[^<]*\n/);
    expect(roundtrip([codeBlock("a\n\tb")]).blocks).toEqual([codeBlock("a\n\tb")]);
  });

  test("6. a styles part defines the styles the document uses", () => {
    const get = parts([
      header(1, [str("h")]),
      codeBlock("c"),
      table({ rows: [[[para([str("t")])]]] }),
    ]);
    const styles = get("word/styles.xml")!;
    for (const id of ["Heading1", "Heading6", "Code", "TableGrid"])
      expect(styles).toContain(`w:styleId="${id}"`);
    expect(get("word/_rels/document.xml.rels")).toContain(`Target="styles.xml"`);
    expect(get("[Content_Types].xml")).toContain("/word/styles.xml");
  });

  // ---- reader

  test("7. explicit off values of toggle properties are off", () => {
    const back = read(
      `<w:p>${r("a", `<w:b w:val="0"/><w:i w:val="false"/><w:strike w:val="off"/><w:u w:val="none"/>`)}${r("b", `<w:b/><w:u w:val="single"/>`)}</w:p>`,
    );
    const content = inlinesOf(back.blocks[0]);
    expect(content[0]).toMatchObject({ _tag: "Str", text: "a" });
    expect(content[1]!._tag).toBe("Underline");
  });

  test("8. numId 0 is not a list", () => {
    const back = read(
      `<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="0"/></w:numPr></w:pPr>${r("x")}</w:p>`,
    );
    expect(back.blocks[0]!._tag).toBe("Para");
  });

  test("9. the list kind comes from numbering.xml", () => {
    const numbering =
      `<w:abstractNum w:abstractNumId="7"><w:lvl w:ilvl="0"><w:numFmt w:val="lowerRoman"/></w:lvl><w:lvl w:ilvl="1"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum>` +
      `<w:num w:numId="9"><w:abstractNumId w:val="7"/></w:num>`;
    const li = (t: string, ilvl: number) =>
      `<w:p><w:pPr><w:numPr><w:ilvl w:val="${ilvl}"/><w:numId w:val="9"/></w:numPr></w:pPr>${r(t)}</w:p>`;
    const back = read(li("i", 0) + li("dot", 1), numbering);
    expect(back.blocks).toEqual([
      orderedList([[plainText("i"), bulletList([[plainText("dot")]])]]),
    ]);
  });

  test("10. tracked insertions are kept and deletions dropped", () => {
    const back = read(
      `<w:p>${r("a")}<w:ins w:id="1">${r("b")}</w:ins><w:del w:id="2"><w:r><w:delText>gone</w:delText></w:r></w:del></w:p>`,
    );
    expect(blocksToText(back.blocks)).toBe("ab");
  });

  test("11. inline and block content controls are kept", () => {
    const back = read(
      `<w:sdt><w:sdtPr/><w:sdtContent><w:p>${r("toc")}</w:p></w:sdtContent></w:sdt>` +
        `<w:p>${r("name: ")}<w:sdt><w:sdtContent>${r("Ada")}</w:sdtContent></w:sdt></w:p>`,
    );
    expect(blocksToText(back.blocks)).toBe("toc\nname: Ada");
  });

  test("12. simple and complex HYPERLINK fields become links; other fields keep their result", () => {
    const back = read(
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
  });

  test("13. internal hyperlinks become #anchor and round-trip", () => {
    const back = read(`<w:p><w:hyperlink w:anchor="intro">${r("Intro")}</w:hyperlink></w:p>`);
    expect(inlinesOf(back.blocks[0])[0]).toMatchObject({ target: { url: "#intro" } });
    const again = roundtrip([para([link([str("x")], "#intro")])]);
    expect(inlinesOf(again.blocks[0])[0]).toMatchObject({ target: { url: "#intro" } });
  });

  test("14. a page break splits the paragraph", () => {
    const back = read(
      `<w:p>${r("one")}<w:r><w:br w:type="page"/></w:r>${r("two")}<w:r><w:br/></w:r>${r("three")}</w:p>`,
    );
    expect(back.blocks.map((b) => b._tag)).toEqual(["Para", "Para"]);
    expect(blocksToText(back.blocks)).toBe("one\ntwo\nthree");
  });
});
