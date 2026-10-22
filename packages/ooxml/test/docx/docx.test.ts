import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  type Block, blocksToText, bulletList, document, emph, type FeaturesOf, header, type Inline, link,
  orderedList, para, plainText, str, strong, table, trustAs,
} from "@thomasfosterau/effect-document";
import { Docx, makeDocxReader, makeDocxWriter } from "../../src/docx/index.js";

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
    if (p?._tag === "Para") {
      expect(findInline(p.content, "Strong")).toBeDefined();
      expect(findInline(p.content, "Emph")).toBeDefined();
    }
  });

  test("preserves a hyperlink and its URL", () => {
    const back = roundtrip([para([str("see "), link([str("here")], "https://example.com")])]);
    const p = back.blocks[0];
    if (p?._tag === "Para") {
      const lnk = p.content.find((i) => i._tag === "Link");
      expect(lnk).toMatchObject({ _tag: "Link", target: { url: "https://example.com" } });
    }
  });

  test("preserves bullet and ordered lists", () => {
    const back = roundtrip([
      bulletList([[plainText("a")], [plainText("b")]]),
      orderedList([[plainText("1")], [plainText("2")]]),
    ]);
    expect(back.blocks.map((b) => b._tag)).toEqual(["BulletList", "OrderedList"]);
    const bl = back.blocks[0];
    if (bl?._tag === "BulletList") expect(bl.items).toHaveLength(2);
  });

  test("preserves a table with a header row", () => {
    const back = roundtrip([
      table({ headers: ["Name", "Age"], rows: [[[plainText("alice")], [plainText("30")]]] }),
    ]);
    const t = back.blocks[0];
    expect(t?._tag).toBe("Table");
    if (t?._tag === "Table") {
      expect(t.head).toHaveLength(1);
      expect(t.body).toHaveLength(1);
      expect(blocksToText([t])).toContain("Name\tAge");
    }
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
    const error = run(Effect.flip(makeDocxReader().read(docx(1500))));
    expect(error).toMatchObject({ code: "LimitExceeded" });
  });
});
