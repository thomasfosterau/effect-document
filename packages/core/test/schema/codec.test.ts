import { assert, describe, expect, test } from "vite-plus/test";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import {
  type Block,
  BlockQuote,
  BulletList,
  CellComment,
  CellRichText,
  Comment,
  Cite,
  Citation,
  DefinitionItem,
  DefinitionList,
  Div,
  Document,
  type DocumentEncoded,
  Emph,
  Figure,
  type Inline,
  LineBlock,
  Note,
  OrderedList,
  Para,
  Placeholder,
  Str,
  TableShape,
  cell,
  codeBlock,
  decodeDocument,
  decodeDocumentResult,
  document,
  encodeDocument,
  encodeDocumentResult,
  header,
  link,
  nestingDepth,
  para,
  slide,
  slideShow,
  str,
  strong,
  table,
  textBox,
  withSheetComments,
  worksheet,
} from "../../src/index.ts";

const x = (): Para => para([new Str({ text: "x" })]);

/** Every kind of recursive field, one wrapper per chain. */
const chains: ReadonlyArray<readonly [string, (b: Block) => Block]> = [
  ["block quotes", (b) => new BlockQuote({ content: [b] })],
  ["divs", (b) => new Div({ content: [b] })],
  ["figures", (b) => new Figure({ caption: [x()], content: [b] })],
  ["bullet lists", (b) => new BulletList({ items: [[b]] })],
  ["ordered lists", (b) => new OrderedList({ start: 3, items: [[x()], [b]] })],
  ["tables", (b) => table({ caption: [str("c")], headers: ["h"], rows: [[[b]]] })],
  [
    "definition lists",
    (b) =>
      new DefinitionList({
        items: [new DefinitionItem({ term: [str("t")], definitions: [[b]] })],
      }),
  ],
  ["notes", (b) => para([new Note({ content: [b] })])],
  [
    "citations and line blocks",
    (b) =>
      new LineBlock({
        lines: [
          [
            new Cite({
              content: [str("c")],
              citations: [
                new Citation({
                  id: "c",
                  mode: "normal",
                  prefix: [new Note({ content: [b] })],
                  suffix: [],
                }),
              ],
            }),
          ],
        ],
      }),
  ],
  ["text boxes", (b) => slideShow([slide([textBox([b])], [x()])])],
  [
    "table shapes and placeholders",
    (b) =>
      slideShow([
        slide([
          new Placeholder({ placeholderType: "body", content: [x()] }),
          new TableShape({ table: table({ rows: [[[b]]] }) }),
        ]),
      ]),
  ],
  [
    "rich-text cells",
    (b) =>
      worksheet("S", [[cell.text("a"), new CellRichText({ runs: [new Note({ content: [b] })] })]]),
  ],
  [
    "comment bodies",
    (b) => worksheetWithComment(new Comment({ author: "A", content: [x(), b], replies: [] }), "S"),
  ],
];

/** A sheet with one comment on A1. */
const worksheetWithComment = (comment: Comment, name: string): Block =>
  withSheetComments(worksheet(name, [["a"]]), [new CellComment({ row: 0, col: 0, comment })]);

/** A comment whose replies chain `n` deep, each reply a comment with a body of its own. */
const replyChain = (n: number): Comment =>
  Array.from({ length: n }).reduce<Comment>(
    (inner, _, i) => new Comment({ author: `r${i}`, content: [x()], replies: [inner] }),
    new Comment({ content: [x()], replies: [] }),
  );

const DEEP = 5_000;

const wrapped = (wrap: (b: Block) => Block, n: number): Document =>
  document([Array.from({ length: n }).reduce<Block>((b) => wrap(b), x())]);

const emphasised = (n: number): Inline =>
  Array.from({ length: n }).reduce<Inline>((i) => new Emph({ content: [i] }), str("y"));

/** JSON text for a value, so key order counts in a comparison. */
const toJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

/** The Schema codec's output for a document, as JSON text. */
const schemaJson = (doc: Document): string => toJson(Schema.encodeUnknownSync(Document)(doc));

/** A result's success, failing the test otherwise. */
const ok = <A, E>(r: Result.Result<A, E>): A => {
  assert(Result.isSuccess(r));
  return r.success;
};

const encoded = (doc: Document): DocumentEncoded => ok(encodeDocumentResult(doc));

/** The error message the codec and the Schema codec give for an invalid input. */
const failures = (input: unknown): readonly [string, string] => {
  const ours = decodeDocumentResult(input);
  const theirs = Schema.decodeUnknownResult(Document)(input);
  assert(Result.isFailure(ours) && Result.isFailure(theirs));
  return [ours.failure.message, theirs.failure.message];
};

describe("the stack-safe Document codec (#191)", () => {
  test("carries a row's plain cells and gaps through, as the Schema codec does", () => {
    const doc = document([
      worksheet("S", [
        ["a", 1, true, undefined, cell.text("b")],
        [cell.blank(), 0.5],
      ]),
    ]);
    expect(toJson(encoded(doc))).toBe(schemaJson(doc));
    const json = Schema.encodeUnknownSync(Document)(doc);
    expect(ok(decodeDocumentResult(json))).toEqual(Schema.decodeUnknownSync(Document)(json));
    // a non-finite plain number fails both codecs
    const bad = {
      meta: {},
      blocks: [
        {
          _tag: "Worksheet",
          name: "S",
          columns: [],
          merges: [],
          rows: [{ index: 0, cells: [Number.NaN] }],
        },
      ],
    };
    expect(Result.isFailure(decodeDocumentResult(bad))).toBe(true);
    expect(Result.isFailure(Schema.decodeUnknownResult(Document)(bad))).toBe(true);
  });

  test.each(chains)("%s: agrees with the Schema codec at a shallow depth", (_, wrap) => {
    const doc = wrapped(wrap, 3);
    expect(toJson(encoded(doc))).toBe(schemaJson(doc));
    const json = Schema.encodeUnknownSync(Document)(doc);
    const back = ok(decodeDocumentResult(json));
    expect(back).toEqual(Schema.decodeUnknownSync(Document)(json));
    expect(back).toEqual(doc);
    expect(back).toBeInstanceOf(Document);
  });

  test.each(chains)("%s: 5,000 levels encode and decode", (_, wrap) => {
    const doc = wrapped(wrap, DEEP);
    const json = encoded(doc);
    const back = ok(decodeDocumentResult(json));
    // (no `toEqual` or `JSON.stringify` here: both recurse, and overflow first)
    expect(nestingDepth(back)).toBe(nestingDepth(doc));
    expect(Result.isSuccess(encodeDocumentResult(back))).toBe(true);
  });

  test("a reply chain 5,000 deep encodes and decodes (#67)", () => {
    const doc = document([worksheetWithComment(replyChain(DEEP), "S")]);
    const back = ok(decodeDocumentResult(encoded(doc)));
    const sheet = back.blocks[0];
    assert(Predicate.isTagged(sheet, "Worksheet"));
    // walk down the chain by loop: `toEqual` would recurse and overflow
    const levels = Arr.unfold(Option.fromUndefinedOr(sheet.comments?.[0]?.comment), (found) =>
      Option.map(found, (c) => [1, Option.fromUndefinedOr(c.replies[0])] as const),
    );
    expect(levels).toHaveLength(DEEP + 1);
  });

  test("a comment's author, initials, date and resolved mark agree with the Schema codec (#67)", () => {
    const doc = document([
      worksheetWithComment(
        new Comment({
          author: "Ann",
          initials: "A",
          date: DateTime.toDateUtc(DateTime.makeUnsafe(0)),
          resolved: true,
          content: [x()],
          replies: [new Comment({ author: "Bo", content: [x()], replies: [] })],
        }),
        "S",
      ),
    ]);
    expect(toJson(encoded(doc))).toBe(schemaJson(doc));
    const json = Schema.encodeUnknownSync(Document)(doc);
    const back = ok(decodeDocumentResult(json));
    expect(back).toEqual(Schema.decodeSync(Document)(json));
    expect(back).toEqual(doc);
    expect(toJson(json)).toContain('"date":"1970-01-01T00:00:00.000Z"');
    // a sheet without comments has no key for them
    expect(toJson(encoded(document([worksheet("S", [["a"]])])))).not.toContain("comments");
  });

  test("50,000 nested inlines encode and decode", () => {
    const doc = document([para([emphasised(50_000)])]);
    const back = ok(decodeDocumentResult(encoded(doc)));
    expect(nestingDepth(back)).toBe(50_002);
  });

  test("keeps metadata, attributes, optional fields and dates as the Schema codec does", () => {
    const doc = document(
      [
        header(2, [str("Hi "), strong([str("there")])]),
        new BulletList({
          attr: { id: "l", classes: ["c"], data: { k: [1, { n: null }] } },
          items: [[para([link([str("x")], "#a", "t")])], [codeBlock("c", "ts")]],
        }),
        worksheet("S", [
          [
            cell.text("a"),
            cell.date(DateTime.toDateUtc(DateTime.makeUnsafe(0))),
            cell.formula("A1", "1"),
            cell.number(-1),
          ],
        ]),
        new Para({ content: [new Emph({ content: [] })] }),
      ],
      { title: "T", nested: { a: [1, 2] } },
    );
    expect(toJson(encoded(doc))).toBe(schemaJson(doc));
    expect(ok(decodeDocumentResult(encoded(doc)))).toEqual(doc);
  });

  test("the Effect forms succeed and fail as the Result forms do", async () => {
    const doc = document([x()]);
    const json = await Effect.runPromise(encodeDocument(doc));
    expect(await Effect.runPromise(decodeDocument(json))).toEqual(doc);
    const error = await Effect.runPromise(Effect.flip(decodeDocument({ meta: {}, blocks: 1 })));
    expect(error._tag).toBe("SchemaError");
  });

  test.each([
    [
      "a heading level out of range",
      { meta: {}, blocks: [{ _tag: "Header", level: 9, content: [] }] },
    ],
    ["a missing field", { meta: {}, blocks: [{ _tag: "Para" }] }],
    ["a wrong own field", { meta: {}, blocks: [{ _tag: "CodeBlock", text: 1 }] }],
    [
      "a bad link target, deep in a list",
      {
        meta: {},
        blocks: [
          {
            _tag: "BulletList",
            items: [[{ _tag: "Para", content: [{ _tag: "Link", content: [], target: 5 }] }]],
          },
        ],
      },
    ],
    ["not an object", 5],
    ["blocks not an array", { meta: {}, blocks: 1 }],
  ])("fails as the Schema codec does on %s", (_, input) => {
    const [ours, theirs] = failures(input);
    expect(ours).toBe(theirs);
  });

  test("fails on an unknown tag, a block among inlines and unordered rows, with a path", () => {
    const unknown = decodeDocumentResult({ meta: {}, blocks: [{ _tag: "Nope" }] });
    assert(Result.isFailure(unknown));
    expect(unknown.failure.message).toContain('["blocks"][0]');

    const misplaced = decodeDocumentResult({
      meta: {},
      blocks: [{ _tag: "Para", content: [{ _tag: "Para", content: [] }] }],
    });
    assert(Result.isFailure(misplaced));
    expect(misplaced.failure.message).toContain('["blocks"][0]["content"][0]');

    const rows = Schema.encodeUnknownSync(Document)(
      document([worksheet("S", [[cell.text("a")], [cell.text("b")]])]),
    );
    const block = rows.blocks[0]!;
    assert(Predicate.isTagged(block, "Worksheet"));
    const input = { ...rows, blocks: [{ ...block, rows: block.rows.toReversed() }] };
    const [ours, theirs] = failures(input);
    expect(ours).toContain("is not after");
    expect(theirs).toContain("is not after");
  });

  test("encoding fails on a node in the wrong position", () => {
    // deliberately malformed: a plain object where a block belongs, put in
    // after construction, since the constructors would refuse it
    const bad = Object.defineProperty(document([]), "blocks", {
      value: [{ _tag: "Para", content: [] }],
    });
    expect(Result.isFailure(encodeDocumentResult(bad))).toBe(true);
    expect(Result.isFailure(Schema.encodeUnknownResult(Document)(bad))).toBe(true);
  });
});
