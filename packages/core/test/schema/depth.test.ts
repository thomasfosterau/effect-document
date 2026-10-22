import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  type Block, BlockQuote, Emph, type Inline, blocksNestingDepth, blocksToText, cellToText,
  collectFeatures, document, inlinesToText, limitNestingDepth, narrow, nestingDepth, para,
  Profiles, Str, table, TableShape, textBox, slide, slideShow, CellRichText,
  DEFAULT_MAX_NESTING_DEPTH,
} from "../../src/index.js";

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
      slideShow([slide([textBox([para([new Str({ text: "d" })]), para([new Str({ text: "e" })])])]), slide([])]),
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
});
