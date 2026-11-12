import * as DateTime from "effect/DateTime";
import * as Equal from "effect/Equal";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { assert, describe, expect, test } from "vite-plus/test";
import {
  CellComment,
  Comment,
  Document,
  Note,
  Table,
  Worksheet,
  blocksToText,
  cell,
  document,
  para,
  str,
  withSheetComments,
  withSheetLayout,
  worksheet,
} from "../../src/schema/index.ts";
import {
  Profiles,
  collectFeatures,
  collectFeaturesWithin,
  defineProfile,
  isThreadComment,
  narrow,
  type Profile,
} from "../../src/profile/index.ts";
import type { Feature } from "../../src/schema/feature.ts";

const text = (s: string) => para([str(s)]);

/** JSON text for a value. */
const toJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

/** A comment on `(row, col)` with a body of paragraphs. */
const noteAt = (
  row: number,
  col: number,
  body: ReadonlyArray<string>,
  rest: Partial<ConstructorParameters<typeof Comment>[0]> = {},
): CellComment =>
  new CellComment({
    row,
    col,
    comment: new Comment({ content: body.map(text), replies: [], ...rest }),
  });

const reply = (author: string, body: string): Comment =>
  new Comment({ author, content: [text(body)], replies: [] });

const sheetWith = (comments: ReadonlyArray<CellComment>): Worksheet =>
  withSheetComments(worksheet("Data", [["a", "b"], ["c"]]), comments);

/** The sheet in a narrowed document. */
const sheetOf = (doc: Document): Worksheet => {
  const ws = doc.blocks[0];
  assert(ws !== undefined && Predicate.isTagged(ws, "Worksheet"));
  return ws;
};

/** The spreadsheet profile without threads. */
const noThreads: Profile<Feature> = defineProfile(
  "comments-only",
  [...Profiles.Spreadsheet.features].filter((f) => f !== "review.threads"),
  { onlyWithin: Profiles.Spreadsheet.onlyWithin },
);

/** The spreadsheet profile without comments (or threads). */
const noComments: Profile<Feature> = defineProfile(
  "no-comments",
  [...Profiles.Spreadsheet.features].filter(
    (f) => !f.startsWith("review.") && !f.startsWith("block."),
  ),
);

describe("Worksheet comments (#67)", () => {
  test("a sheet without comments has no comments key; one with them keeps new Worksheet's key order", () => {
    const plain = worksheet("S", [["a"]]);
    expect("comments" in plain).toBe(false);
    expect(withSheetComments(plain, [])).toBe(plain);
    const [c] = [noteAt(0, 0, ["hi"])];
    assert(c !== undefined);
    const fast = withSheetComments(plain, [c]);
    const slow = new Worksheet({
      name: "S",
      columns: [],
      rows: plain.rows,
      merges: [],
      comments: [c],
    });
    expect(Reflect.ownKeys(fast)).toEqual(Reflect.ownKeys(slow));
    expect(Equal.equals(fast, slow)).toBe(true);
    // withSheetLayout carries them through, trusted or checked
    const laidOut = withSheetLayout(fast, [], [], "hidden");
    expect(laidOut.comments).toEqual([c]);
    expect(Reflect.ownKeys(laidOut)).toEqual(
      Reflect.ownKeys(
        new Worksheet({
          name: "S",
          columns: [],
          rows: plain.rows,
          merges: [],
          visibility: "hidden",
          comments: [c],
        }),
      ),
    );
    // merges that are not instances take the checking path, which carries them too
    const plainMerge = [{ fromRow: 0, fromCol: 0, toRow: 0, toCol: 1 }];
    expect(withSheetLayout(fast, [], plainMerge).comments).toEqual([c]);
  });

  test("a comment round-trips the Schema codec, its date as ISO text", () => {
    const doc = document([
      sheetWith([
        noteAt(0, 1, ["one", "two"], {
          author: "Ann",
          initials: "A",
          date: DateTime.toDateUtc(DateTime.makeUnsafe("2026-03-04T05:06:07.000Z")),
          resolved: true,
          replies: [reply("Bo", "yes")],
        }),
      ]),
    ]);
    const json = Schema.encodeUnknownSync(Document)(doc);
    expect(toJson(json)).toContain('"date":"2026-03-04T05:06:07.000Z"');
    expect(Schema.decodeSync(Document)(json)).toEqual(doc);
  });

  test("a comment's blocks, its replies' and the threads are collected as features", () => {
    const plain = collectFeatures(document([sheetWith([noteAt(0, 0, ["x"])])]));
    expect(plain.has("review.comments")).toBe(true);
    expect(plain.has("review.threads")).toBe(false);
    // the body's blocks and inlines are document content
    expect(plain.has("block.para")).toBe(true);
    expect(plain.has("inline.str")).toBe(true);
    const resolved = collectFeatures(
      document([sheetWith([noteAt(0, 0, ["x"], { resolved: false })])]),
    );
    expect(resolved.has("review.threads")).toBe(true);
    // a reply's body is collected too, however deep
    const deep = collectFeatures(
      document([
        sheetWith([
          noteAt(0, 0, ["x"], {
            replies: [
              new Comment({
                content: [text("y")],
                replies: [
                  new Comment({
                    content: [new Table({ colSpecs: [], head: [], body: [], foot: [] })],
                    replies: [],
                  }),
                ],
              }),
            ],
          }),
        ]),
      ]),
    );
    expect(deep.has("review.threads")).toBe(true);
    expect(deep.has("block.table")).toBe(true);
    expect(collectFeatures(document([worksheet("S", [["a"]])])).has("review.comments")).toBe(false);
  });

  test("Spreadsheet allows comments with prose bodies only inside them", () => {
    expect(Profiles.Spreadsheet.is(document([sheetWith([noteAt(0, 0, ["x"])])]))).toBe(true);
    // a paragraph at the top level of a spreadsheet is still not allowed
    expect(Profiles.Spreadsheet.is(document([text("loose")]))).toBe(false);
    expect(Profiles.Csv.is(document([sheetWith([noteAt(0, 0, ["x"])])]))).toBe(false);
  });
});

describe("narrow: comments (#67)", () => {
  test("a target without comments drops each, one entry per comment at its cell", () => {
    const doc = document([sheetWith([noteAt(0, 1, ["x"]), noteAt(1, 0, ["y"])])]);
    const { document: out, loss } = narrow(doc, noComments);
    expect(sheetOf(out).comments).toBeUndefined();
    expect(loss.entries.map((e) => [e.feature, e.action, e.path, e.detail])).toEqual([
      ["review.comments", "dropped", [0, "B1"], "comment dropped"],
      ["review.comments", "dropped", [0, "A2"], "comment dropped"],
    ]);
  });

  test("a target without threads folds replies into the comment and drops the resolved mark", () => {
    const doc = document([
      sheetWith([
        noteAt(0, 0, ["question"], {
          author: "Ann",
          resolved: true,
          replies: [
            new Comment({
              author: "Bo",
              content: [text("answer")],
              replies: [reply("Cy", "thanks")],
            }),
          ],
        }),
        noteAt(1, 0, ["plain"]),
      ]),
    ]);
    const { document: out, loss } = narrow(doc, noThreads);
    const [folded, untouched] = sheetOf(out).comments ?? [];
    assert(folded !== undefined && untouched !== undefined);
    expect(folded.comment.replies).toEqual([]);
    expect(folded.comment.resolved).toBeUndefined();
    expect(folded.comment.author).toBe("Ann");
    expect(blocksToText(folded.comment.content)).toBe("question\nBo: answer\nCy: thanks");
    expect(untouched.comment.content).toEqual(doc.blocks[0] && [text("plain")]);
    expect(loss.entries.map((e) => [e.feature, e.action, e.severity, e.path])).toEqual([
      ["review.threads", "converted", "converted", [0, "A1"]],
    ]);
    expect(Profiles.Spreadsheet.is(out)).toBe(true);
  });

  test("a comment's body is narrowed like any blocks: what the target lacks is reported at the comment", () => {
    const body = new Comment({
      content: [para([new Note({ content: [text("n")] }), str("tail")])],
      replies: [],
    });
    const doc = document([sheetWith([new CellComment({ row: 0, col: 1, comment: body })])]);
    const noNotes = defineProfile(
      "no-notes",
      [...Profiles.Spreadsheet.features].filter((f) => f !== "inline.note"),
      { onlyWithin: Profiles.Spreadsheet.onlyWithin },
    );
    const { document: out, loss } = narrow(doc, noNotes);
    expect(loss.entries.map((e) => [e.feature, e.action, e.path])).toEqual([
      ["inline.note", "dropped", [0, "B1", "content", 0, 0]],
    ]);
    expect(noNotes.is(out)).toBe(true);
    expect(narrow(doc, Profiles.Spreadsheet).loss.isLossless).toBe(true);
  });

  test("a worksheet converted to a prose table puts each comment in a note in its cell", () => {
    const doc = document([
      sheetWith([
        noteAt(0, 1, ["first"], { replies: [reply("Bo", "reply")] }),
        noteAt(5, 5, ["off the grid"]),
      ]),
    ]);
    const { document: out, loss } = narrow(doc, Profiles.Html);
    const table = out.blocks[0];
    assert(table !== undefined && Predicate.isTagged(table, "Table"));
    const cellContent = table.body[0]?.cells[1]?.content ?? [];
    expect(cellContent).toHaveLength(1);
    const noted = cellContent[0];
    assert(noted !== undefined && Predicate.isTagged(noted, "Plain"));
    expect(noted.content.map((i) => i._tag)).toEqual(["Str", "Note"]);
    const note = noted.content[1];
    assert(note !== undefined && Predicate.isTagged(note, "Note"));
    expect(blocksToText(note.content)).toBe("first\nBo: reply");
    expect(loss.entries.map((e) => [e.feature, e.action, e.path])).toEqual([
      ["review.comments", "converted", [0, "B1"]],
      ["review.comments", "dropped", [0, "F6"]],
      ["sheet.worksheet", "converted", [0]],
    ]);
  });

  test("a target without notes then drops the table-cell note, as it drops any note", () => {
    const doc = document([sheetWith([noteAt(0, 0, ["first"])])]);
    const noNotes = defineProfile(
      "table-without-notes",
      [...Profiles.Html.features].filter((f) => f !== "inline.note"),
    );
    const { loss } = narrow(doc, noNotes);
    expect(loss.entries.map((e) => [e.feature, e.action])).toEqual([
      ["review.comments", "converted"],
      ["sheet.worksheet", "converted"],
      ["inline.note", "dropped"],
    ]);
  });

  test("a worksheet that becomes paragraphs reports its comments dropped", () => {
    const doc = document([sheetWith([noteAt(1, 0, ["x"])])]);
    const paragraphs = defineProfile("paragraphs", ["block.para", "inline.str"]);
    const { loss } = narrow(doc, paragraphs);
    expect(loss.entries.map((e) => [e.feature, e.action, e.path])).toContainEqual([
      "review.comments",
      "dropped",
      [0, "A2"],
    ]);
  });

  test("cells beside the comments narrow as before", () => {
    const doc = document([
      withSheetComments(worksheet("S", [[cell.date(DateTime.toDateUtc(DateTime.makeUnsafe(0)))]]), [
        noteAt(0, 0, ["x"]),
      ]),
    ]);
    const noDates = defineProfile(
      "no-dates",
      [...noComments.features].filter((f) => f !== "cell.date"),
    );
    const { document: out, loss } = narrow(doc, noDates);
    expect(loss.entries.map((e) => e.feature)).toEqual(["cell.date", "review.comments"]);
    expect(sheetOf(out).comments).toBeUndefined();
  });
});

describe("threads as a container for structural rules (#67)", () => {
  const thread = noteAt(0, 0, ["q"], { replies: [reply("Bo", "a")] });
  const resolved = noteAt(1, 0, ["r"], { resolved: false });
  const dated = noteAt(1, 1, ["n"], { date: DateTime.toDateUtc(DateTime.makeUnsafe(0)) });

  test("a thread is a comment with replies or a resolved mark, and nothing else", () => {
    expect([thread, resolved, dated].map((c) => isThreadComment(c.comment))).toEqual([
      true,
      true,
      false,
    ]);
  });

  test("a thread's comments, root and replies, are inside review.threads as well as review.comments", () => {
    const doc = document([sheetWith([thread, noteAt(1, 1, ["note"])])]);
    expect(collectFeaturesWithin(doc, "review.comments")).toContain("block.para");
    expect(collectFeaturesWithin(doc, "review.threads").size).toBe(2);
    // a plain note alone is no thread
    expect(
      collectFeaturesWithin(document([sheetWith([noteAt(1, 1, ["note"])])]), "review.threads").size,
    ).toBe(0);
  });
});
