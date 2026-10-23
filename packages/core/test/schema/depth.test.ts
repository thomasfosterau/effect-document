import { describe, expect, test } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Predicate from "effect/Predicate";
import {
  type Block,
  BlockQuote,
  BulletList,
  Cite,
  Citation,
  DefinitionItem,
  DefinitionList,
  Document,
  Emph,
  type Inline,
  blocksNestingDepth,
  blocksToText,
  cellToText,
  collectFeatures,
  document,
  inlinesToText,
  limitNestingDepth,
  narrow,
  nestingDepth,
  para,
  Profiles,
  Str,
  table,
  TableShape,
  textBox,
  slide,
  slideShow,
  CellRichText,
  DEFAULT_MAX_NESTING_DEPTH,
} from "../../src/index.ts";

const DEEP = 20_000;

/** A paragraph wrapped in `n` block quotes. */
const quoted = (n: number): Block => {
  let b: Block = para([new Str({ text: "x" })]);
  for (let i = 0; i < n; i++) b = new BlockQuote({ content: [b] });
  return b;
};

/** A string wrapped in `n` Emph inlines. */
const emphasised = (n: number): Inline => {
  let i: Inline = new Str({ text: "y" });
  for (let k = 0; k < n; k++) i = new Emph({ content: [i] });
  return i;
};

describe("deep nesting (#110)", () => {
  test("Profile.is and collectFeatures handle 20,000 levels", () => {
    const doc = document([quoted(DEEP), para([emphasised(DEEP)])]);
    expect(Profiles.Markdown.is(doc)).toBe(true);
    expect(Profiles.Csv.is(doc)).toBe(false);
    expect(collectFeatures(doc).has("inline.emph")).toBe(true);
  });

  test("the text collapse handles 20,000 levels", () => {
    expect(blocksToText([quoted(DEEP)])).toBe("x");
    expect(inlinesToText([emphasised(DEEP)])).toBe("y");
    expect(cellToText(new CellRichText({ runs: [emphasised(DEEP)] }))).toBe("y");
  });

  test("the text collapse keeps its separators", () => {
    const blocks: Block[] = [
      para([new Str({ text: "a" })]),
      table({ rows: [[[para([new Str({ text: "b" })])], [para([new Str({ text: "c" })])]]] }),
      slideShow([
        slide([textBox([para([new Str({ text: "d" })]), para([new Str({ text: "e" })])])]),
        slide([]),
      ]),
    ];
    expect(blocksToText(blocks)).toBe("a\nb\tc\nd\ne\n\n");
  });

  test("nestingDepth measures 20,000 levels without recursion", () => {
    expect(nestingDepth(document([]))).toBe(0);
    expect(nestingDepth(document([para([new Str({ text: "x" })])]))).toBe(2);
    expect(nestingDepth(document([quoted(DEEP)]))).toBe(DEEP + 2);
    expect(blocksNestingDepth([quoted(DEEP)], 10)).toBe(11);
    const shape = new TableShape({ table: table({ rows: [[[quoted(3)]]] }) });
    expect(nestingDepth(document([slideShow([slide([shape])])]))).toBe(3 + 5); // SlideShow > TableShape > Table > 3 quotes > Para > Str
  });

  test("limitNestingDepth fails with a LimitExceeded ParseError", async () => {
    const deep = document([quoted(DEFAULT_MAX_NESTING_DEPTH)]);
    const error = await Effect.runPromise(Effect.flip(limitNestingDepth("test", deep)));
    expect(error).toMatchObject({ _tag: "ParseError", format: "test", code: "LimitExceeded" });

    const ok = document([quoted(DEFAULT_MAX_NESTING_DEPTH - 2)]);
    expect(await Effect.runPromise(limitNestingDepth("test", ok))).toBe(ok);
  });

  test("narrow handles documents at the readers' default limit", () => {
    const doc = document([quoted(DEFAULT_MAX_NESTING_DEPTH - 2)]);
    expect(() => narrow(doc, Profiles.Csv)).not.toThrow();
    expect(narrow(doc, Profiles.Markdown).loss.isLossless).toBe(true);
  });

  /**
   * One chain per kind of nesting, from the cheapest for Schema to recurse
   * through to the dearest (a Table level is Table, TableRow and Cell).
   */
  const chains: ReadonlyArray<readonly [string, (b: Block) => Block]> = [
    ["block quotes", (b) => new BlockQuote({ content: [b] })],
    ["bullet lists", (b) => new BulletList({ items: [[b]] })],
    ["tables", (b) => table({ rows: [[[b]]] })],
    [
      "definition lists",
      (b) =>
        new DefinitionList({
          items: [new DefinitionItem({ term: [new Str({ text: "t" })], definitions: [[b]] })],
        }),
    ],
    [
      "citations",
      (b) =>
        para([
          new Cite({
            content: [],
            citations: [
              new Citation({
                id: "c",
                mode: "normal",
                prefix: Predicate.isTagged(b, "Para") ? b.content : [],
                suffix: [],
              }),
            ],
          }),
        ]),
    ],
  ];

  /** A document as deep as `wrap` can make it without exceeding `depth`. */
  const chain = (wrap: (b: Block) => Block, depth: number): Document => {
    const base: Block = para([new Str({ text: "x" })]);
    const start = blocksNestingDepth([base]);
    const step = blocksNestingDepth([wrap(base)]) - start;
    const levels = Math.floor((depth - start) / step);
    return document([Array.from({ length: levels }).reduce<Block>((b) => wrap(b), base)]);
  };

  test.each(chains)(
    "%s at the readers' default limit encode, decode, narrow and validate",
    (_, wrap) => {
      const doc = chain(wrap, DEFAULT_MAX_NESTING_DEPTH);
      expect(nestingDepth(doc)).toBeGreaterThanOrEqual(DEFAULT_MAX_NESTING_DEPTH - 2);
      expect(nestingDepth(doc)).toBeLessThanOrEqual(DEFAULT_MAX_NESTING_DEPTH);
      const wire = Schema.fromJsonString(Document);
      expect(Schema.decodeUnknownSync(wire)(Schema.encodeUnknownSync(wire)(doc))).toEqual(doc);
      expect(() => narrow(doc, Profiles.Markdown)).not.toThrow();
      expect(() => narrow(doc, Profiles.Csv)).not.toThrow();
      expect(Profiles.Full.is(doc)).toBe(true);
    },
  );
});
