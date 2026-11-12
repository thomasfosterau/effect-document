import { it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Rec from "effect/Record";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { assert, describe, expect } from "vite-plus/test";
import {
  blocksToText,
  bytes,
  CellComment,
  collectDiagnostics,
  Comment,
  type Content,
  type Diagnostic,
  document,
  emph,
  narrow,
  Para,
  strong,
  str,
  trustAs,
  type Worksheet,
  withSheetComments,
  worksheet,
  softBreak,
  space,
} from "@thomasfosterau/effect-document";
import {
  makeXlsxReader,
  makeXlsxWriter,
  Xlsx,
  XlsxRead,
  type XlsxFeature,
} from "../../../src/ooxml/xlsx/index.ts";

/** The bytes of written content. */
const bytesOf = (c: Content): Uint8Array => {
  assert(Predicate.isTagged(c, "Bytes"), "the XLSX writer writes bytes");
  return c.bytes;
};

/** A part of a workbook, as text ("" when absent). */
const partOf = (data: Uint8Array, path: string): string =>
  strFromU8(unzipSync(data)[path] ?? new Uint8Array());

/** The names of a workbook's parts. */
const partNames = (data: Uint8Array): ReadonlyArray<string> => Object.keys(unzipSync(data));

const para = (...inlines: ConstructorParameters<typeof Para>[0]["content"]): Para =>
  new Para({ content: inlines });

/** A comment at `(row, col)` with `body`. */
const note = (row: number, col: number, body: ReadonlyArray<Para>, author?: string): CellComment =>
  new CellComment({
    row,
    col,
    comment: new Comment({ author, content: body, replies: [] }),
  });

const sheet = (name: string, comments: ReadonlyArray<CellComment>): Worksheet =>
  withSheetComments(worksheet(name, [["a", "b"], ["c"]]), comments);

const write = (sheets: ReadonlyArray<Worksheet>) =>
  collectDiagnostics(makeXlsxWriter().write(trustAs<XlsxFeature>(document(sheets))));

/** The sheets `data` reads as, with the diagnostics the read reported. */
const read = (data: Uint8Array) =>
  Effect.map(
    collectDiagnostics(makeXlsxReader().read(bytes(data))),
    ([doc, found]): readonly [ReadonlyArray<Worksheet>, ReadonlyArray<Diagnostic>] => [
      doc.blocks.filter((b): b is Worksheet => Predicate.isTagged(b, "Worksheet")),
      found,
    ],
  );

/** Why the writer refuses a sheet "S" with these comments. */
const refusal = (comments: ReadonlyArray<CellComment>) =>
  Effect.map(
    Effect.flip(makeXlsxWriter().write(trustAs<XlsxFeature>(document([sheet("S", comments)])))),
    (error) => error.reason,
  );

describe("XLSX legacy comments (#67)", () => {
  const original = sheet("S", [
    note(
      0,
      0,
      [para(str("Ann:")), para(str("first"), space(), str("line")), para(emph([str("second")]))],
      "Ann",
    ),
    note(1, 3, [para(strong([str("bold")]), space(), str("tail"))], "Bo"),
    note(4, 1, [para(str("no"), space(), str("author"))]),
  ]);

  it.effect("round-trip author, several lines and marked runs", () =>
    Effect.gen(function* () {
      const [content, notes] = yield* write([original]);
      expect(notes).toEqual([]);
      const [[back], found] = yield* read(bytesOf(content));
      expect(found).toEqual([]);
      expect(back?.comments).toEqual(original.comments);
      expect(Xlsx.is(document([original]))).toBe(true);
    }),
  );

  it.effect(
    "writes the comments part, the VML drawing, the relationships and the content types",
    () =>
      Effect.gen(function* () {
        const [content] = yield* write([original]);
        const data = bytesOf(content);
        const comments = partOf(data, "xl/comments1.xml");
        expect(comments).toContain(
          "<authors><author>Ann</author><author>Bo</author><author></author></authors>",
        );
        expect(comments).toContain('<comment ref="A1" authorId="0"><text>');
        expect(comments).toContain('<comment ref="D2" authorId="1">');
        expect(comments).toContain('<comment ref="B5" authorId="2">');
        expect(comments).toContain('<rPr><b/></rPr><t xml:space="preserve">bold</t>');
        const vml = partOf(data, "xl/drawings/vmlDrawing1.vml");
        expect(vml).toContain('<x:ClientData ObjectType="Note">');
        expect(vml).toContain("<x:Row>1</x:Row><x:Column>3</x:Column>");
        expect(vml).toContain('<o:idmap v:ext="edit" data="1"/>');
        expect(vml.match(/<v:shape /g)).toHaveLength(3);
        const sheetXml = partOf(data, "xl/worksheets/sheet1.xml");
        expect(sheetXml).toContain('<legacyDrawing r:id="rId2"/></worksheet>');
        expect(sheetXml).toContain("xmlns:r=");
        const rels = partOf(data, "xl/worksheets/_rels/sheet1.xml.rels");
        expect(rels).toContain(
          'Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="../comments1.xml"',
        );
        expect(rels).toContain(
          'Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/vmlDrawing" Target="../drawings/vmlDrawing1.vml"',
        );
        const types = partOf(data, "[Content_Types].xml");
        expect(types).toContain(
          '<Default Extension="vml" ContentType="application/vnd.openxmlformats-officedocument.vmlDrawing"/>',
        );
        expect(types).toContain(
          '<Override PartName="/xl/comments1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.comments+xml"/>',
        );
      }),
  );

  it.effect("a sheet without comments writes none of it", () =>
    Effect.gen(function* () {
      const [content] = yield* write([worksheet("S", [["a"]])]);
      const data = bytesOf(content);
      expect(partNames(data).filter((n) => /comments|vml/.test(n))).toEqual([]);
      expect(partOf(data, "[Content_Types].xml")).not.toContain("vml");
      expect(partOf(data, "xl/worksheets/sheet1.xml")).not.toContain("legacyDrawing");
    }),
  );

  it.effect("the output is byte-for-byte reproducible", () =>
    Effect.gen(function* () {
      const [firstContent] = yield* write([original]);
      const first = bytesOf(firstContent);
      const [secondContent] = yield* write([original]);
      const second = bytesOf(secondContent);
      expect(first).toEqual(second);
    }),
  );

  it.effect(
    "comments on two sheets are numbered in order, sharing a relationship file with hyperlinks",
    () =>
      Effect.gen(function* () {
        const plain = worksheet("Plain", [["x"]]);
        const [content] = yield* write([
          plain,
          sheet("B", [note(0, 0, [para(str("b"))], "Bo")]),
          sheet("C", [note(2, 2, [para(str("c"))], "Cy")]),
        ]);
        const data = bytesOf(content);
        expect(partOf(data, "xl/worksheets/sheet1.xml")).not.toContain("legacyDrawing");
        expect(partOf(data, "xl/worksheets/_rels/sheet2.xml.rels")).toContain("../comments1.xml");
        expect(partOf(data, "xl/worksheets/_rels/sheet3.xml.rels")).toContain("../comments2.xml");
        expect(partOf(data, "xl/drawings/vmlDrawing2.vml")).toContain('data="2"');
        expect(partOf(data, "xl/drawings/vmlDrawing2.vml")).toContain("_x0000_s2049");
        const [sheets] = yield* read(data);
        expect(sheets.map((s) => s.comments?.length)).toEqual([undefined, 1, 1]);
        expect(sheets[2]?.comments?.[0]).toEqual(note(2, 2, [para(str("c"))], "Cy"));
      }),
  );

  it.effect("a comment on a blank cell past the rows round-trips", () =>
    Effect.gen(function* () {
      const far = sheet("S", [note(30, 20, [para(str("far"))])]);
      const [[back]] = yield* read(bytesOf((yield* write([far]))[0]));
      expect(back?.comments).toEqual(far.comments);
    }),
  );

  it.effect(
    "the writer refuses what it can't write: two comments on a cell, a cell outside the sheet",
    () =>
      Effect.gen(function* () {
        expect(
          yield* refusal([note(0, 0, [para(str("a"))]), note(0, 0, [para(str("b"))])]),
        ).toContain("two comments on A1");
        expect(yield* refusal([note(0, 16_384, [para(str("a"))])])).toContain("outside the sheet");
      }),
  );

  it.effect("a line break inside a paragraph is read back as a new paragraph", () =>
    Effect.gen(function* () {
      const wrapped = sheet("S", [note(0, 0, [para(str("a"), softBreak(), str("b"))])]);
      const [[back]] = yield* read(bytesOf((yield* write([wrapped]))[0]));
      expect(back?.comments?.[0]?.comment.content).toEqual([para(str("a")), para(str("b"))]);
    }),
  );
});

// ---- a workbook built by hand: threaded comments ---------------------------

const NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PKG = "http://schemas.openxmlformats.org/package/2006/relationships";
const MS = "http://schemas.microsoft.com/office/2017/10/relationships";

const rels = (items: ReadonlyArray<readonly [id: string, type: string, target: string]>) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${PKG}">${items
    .map(([id, type, target]) => `<Relationship Id="${id}" Type="${type}" Target="${target}"/>`)
    .join("")}</Relationships>`;

const THREADED = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<ThreadedComments xmlns="http://schemas.microsoft.com/office/spreadsheetml/2018/threadedcomments">
<threadedComment ref="B2" dT="2026-02-03T10:00:00.00" personId="{P1}" id="{T1}" done="1"><text>Is this right?
Check the total.</text></threadedComment>
<threadedComment ref="B2" dT="2026-02-03T12:30:00.00" personId="{P2}" id="{T3}" parentId="{T1}"><text>Second reply</text></threadedComment>
<threadedComment ref="B2" dT="2026-02-03T11:00:00.00" personId="{P2}" id="{T2}" parentId="{T1}"><text>First reply</text></threadedComment>
</ThreadedComments>`;

const PERSONS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<personList xmlns="http://schemas.microsoft.com/office/spreadsheetml/2018/threadedcomments"><person displayName="Ann Author" id="{P1}" userId="ann" providerId="None"/><person displayName="Bo Reviewer" id="{P2}" userId="bo" providerId="None"/></personList>`;

/** Excel's legacy placeholder for the thread at B2, and an ordinary note at A1. */
const LEGACY = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<comments xmlns="${NS}"><authors><author>tc={T1}</author><author>Cy</author></authors><commentList>
<comment ref="B2" authorId="0"><text><t>[Threaded comment]

Your version of Excel allows you to read this threaded comment; however, any edits to it will get removed if the file is opened in a newer version of Excel.

Comment:
    Is this right?</t></text></comment>
<comment ref="A1" authorId="1"><text><r><rPr><b/><sz val="9"/></rPr><t>Cy:</t></r><r><rPr><sz val="9"/></rPr><t xml:space="preserve">
plain note</t></r></text></comment>
</commentList></comments>`;

/** A one-sheet workbook with the given extra parts and sheet relationships. */
const workbook = (
  parts: Record<string, string>,
  sheetRels: ReadonlyArray<readonly [string, string, string]>,
  workbookRels: ReadonlyArray<readonly [string, string, string]> = [],
): Uint8Array =>
  zipSync({
    "[Content_Types].xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>`,
    ),
    "_rels/.rels": strToU8(rels([["rId1", `${REL}/officeDocument`, "xl/workbook.xml"]])),
    "xl/workbook.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="${NS}" xmlns:r="${REL}"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    ),
    "xl/_rels/workbook.xml.rels": strToU8(
      rels([["rId1", `${REL}/worksheet`, "worksheets/sheet1.xml"], ...workbookRels]),
    ),
    "xl/worksheets/sheet1.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="${NS}"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>x</t></is></c></row></sheetData></worksheet>`,
    ),
    "xl/worksheets/_rels/sheet1.xml.rels": strToU8(rels(sheetRels)),
    ...Rec.map(parts, (v) => strToU8(v)),
  });

describe("XLSX threaded comments (#67)", () => {
  const threaded = workbook(
    {
      "xl/comments1.xml": LEGACY,
      "xl/threadedComments/threadedComment1.xml": THREADED,
      "xl/persons/person.xml": PERSONS,
    },
    [
      ["rId1", `${REL}/comments`, "../comments1.xml"],
      ["rId2", `${MS}/threadedComment`, "../threadedComments/threadedComment1.xml"],
    ],
    [["rId9", `${MS}/person`, "persons/person.xml"]],
  );

  it.effect("a cell with a thread takes it: root, replies by time, resolved, date and author", () =>
    Effect.gen(function* () {
      const [[back], found] = yield* read(threaded);
      expect(found).toEqual([]);
      const comments = back?.comments ?? [];
      // the placeholder at B2 is not a second comment; the ordinary note at A1 is read
      expect(comments.map((c) => [c.row, c.col])).toEqual([
        [0, 0],
        [1, 1],
      ]);
      const [plain, thread] = comments;
      assert(plain !== undefined && thread !== undefined);
      expect(plain.comment.author).toBe("Cy");
      expect(plain.comment.content).toEqual([
        para(strong([str("Cy:")])),
        para(str("plain"), space(), str("note")),
      ]);
      expect(thread.comment.author).toBe("Ann Author");
      expect(thread.comment.resolved).toBe(true);
      expect(thread.comment.date).toEqual(
        DateTime.toDateUtc(DateTime.makeUnsafe("2026-02-03T10:00:00.000Z")),
      );
      expect(thread.comment.content).toHaveLength(2);
      expect(thread.comment.replies.map((r) => [r.author, r.date?.toISOString()])).toEqual([
        ["Bo Reviewer", "2026-02-03T11:00:00.000Z"],
        ["Bo Reviewer", "2026-02-03T12:30:00.000Z"],
      ]);
      expect(thread.comment.replies[0]?.content).toEqual([
        para(str("First"), space(), str("reply")),
      ]);
      expect(XlsxRead.is(document(back === undefined ? [] : [back]))).toBe(true);
      expect(Xlsx.is(document(back === undefined ? [] : [back]))).toBe(true);
    }),
  );

  it.effect("a sheet with only a legacy placeholder and no threaded part reads it as a note", () =>
    Effect.gen(function* () {
      const data = workbook({ "xl/comments1.xml": LEGACY }, [
        ["rId1", `${REL}/comments`, "../comments1.xml"],
      ]);
      const [[back]] = yield* read(data);
      expect(back?.comments?.map((c) => [c.row, c.col])).toEqual([
        [0, 0],
        [1, 1],
      ]);
    }),
  );

  it.effect(
    "an unknown person leaves the author off; a missing part is noted and the rest read",
    () =>
      Effect.gen(function* () {
        const data = workbook({ "xl/threadedComments/threadedComment1.xml": THREADED }, [
          ["rId1", `${REL}/comments`, "../comments1.xml"],
          ["rId2", `${MS}/threadedComment`, "../threadedComments/threadedComment1.xml"],
        ]);
        const [[back], found] = yield* read(data);
        expect(back?.comments?.[0]?.comment.author).toBeUndefined();
        expect(back?.comments?.[0]?.comment.replies).toHaveLength(2);
        expect(found.map((d) => [d.code, d.severity, d.path])).toEqual([
          ["xlsx.commentDropped", "dropped-content", ["S"]],
        ]);
        expect(found[0]?.detail).toContain("xl/comments1.xml is missing");
      }),
  );

  it.effect("a comment whose ref is not a cell is left out and reported", () =>
    Effect.gen(function* () {
      const data = workbook(
        {
          "xl/comments1.xml": `<comments xmlns="${NS}"><authors><author>A</author></authors><commentList><comment ref="nope" authorId="0"><text><t>x</t></text></comment><comment ref="C3" authorId="0"><text><t>y</t></text></comment></commentList></comments>`,
        },
        [["rId1", `${REL}/comments`, "../comments1.xml"]],
      );
      const [[back], found] = yield* read(data);
      expect(back?.comments?.map((c) => [c.row, c.col])).toEqual([[2, 2]]);
      expect(found[0]?.detail).toContain('"nope"');
    }),
  );

  it.effect("a malformed comments part fails the read, positioned at the sheet and part", () =>
    Effect.gen(function* () {
      const data = workbook({ "xl/comments1.xml": "<comments><authors></comments>" }, [
        ["rId1", `${REL}/comments`, "../comments1.xml"],
      ]);
      const error = yield* Effect.flip(makeXlsxReader().read(bytes(data)));
      expect(error.code).toBe("MalformedXml");
      expect(error.position?.sheet).toBe("S");
      expect(error.position?.part).toBe("xl/comments1.xml");
    }),
  );

  it.effect("a preview read keeps the comments on the rows it kept", () =>
    Effect.gen(function* () {
      const [content] = yield* write([
        withSheetComments(worksheet("S", [["a"], ["b"], ["c"]]), [
          note(0, 0, [para(str("kept"))]),
          note(2, 0, [para(str("cut"))]),
        ]),
      ]);
      const [doc] = yield* collectDiagnostics(
        makeXlsxReader({ maxRows: 2 }).read(bytes(bytesOf(content))),
      );
      const ws = doc.blocks[0];
      assert(ws !== undefined && Predicate.isTagged(ws, "Worksheet"));
      expect(ws.comments?.map((c) => c.row)).toEqual([0]);
    }),
  );
});

// ---- threaded comments, written ---------------------------------------------

/** A comment of a thread: plain paragraphs, an author, a date ("" for none of either) and, optionally, a resolved mark. */
const said = (
  author: string,
  at: string,
  lines: ReadonlyArray<string>,
  rest: { readonly resolved?: boolean; readonly replies?: ReadonlyArray<Comment> } = {},
): Comment =>
  new Comment({
    author: author === "" ? undefined : author,
    date: at === "" ? undefined : DateTime.toDateUtc(DateTime.makeUnsafe(at)),
    resolved: rest.resolved,
    content: lines.map((line) => para(...words(line))),
    replies: rest.replies ?? [],
  });

/** A line as the words and spaces the reader finds in it. */
const words = (line: string) =>
  line.split(" ").flatMap((word, i) => (i === 0 ? [str(word)] : [space(), str(word)]));

const blocksText = (content: Comment["content"]): string => blocksToText(content);

const at = (row: number, col: number, comment: Comment): CellComment =>
  new CellComment({ row, col, comment });

const discussion = said("Ann", "2026-02-03T10:00:00.000Z", ["Is this right?", "Check the total."], {
  resolved: true,
  replies: [
    said("Bo", "2026-02-03T11:00:00.000Z", ["First reply"]),
    said("Ann", "2026-02-03T12:30:15.250Z", ["Second", "reply"], { resolved: false }),
  ],
});

describe("XLSX threaded comments, written (#67)", () => {
  const original = sheet("S", [
    at(0, 0, discussion),
    note(1, 1, [para(strong([str("plain")]))], "Cy"),
    at(3, 2, said("Bo", "2026-03-01T09:00:00.000Z", ["alone"], { resolved: true })),
  ]);

  it.effect("a thread, its replies, dates, resolved marks and authors round-trip", () =>
    Effect.gen(function* () {
      expect(Xlsx.is(document([original]))).toBe(true);
      const [content, notes] = yield* write([original]);
      expect(notes).toEqual([]);
      const [[back], found] = yield* read(bytesOf(content));
      expect(found).toEqual([]);
      expect(back?.comments).toEqual(original.comments);
    }),
  );

  it.effect("writes the threaded part, the people, the placeholder note and the wiring", () =>
    Effect.gen(function* () {
      const [content] = yield* write([original]);
      const data = bytesOf(content);
      const threaded = partOf(data, "xl/threadedComments/threadedComment1.xml");
      expect(threaded).toContain(
        '<ThreadedComments xmlns="http://schemas.microsoft.com/office/spreadsheetml/2018/threadedcomments"',
      );
      expect(threaded).toContain(
        '<threadedComment ref="A1" dT="2026-02-03T10:00:00.000" personId="{00000000-FFFF-4000-8000-000000000000}" id="{00000000-0000-4000-8000-000001000000}" done="1"><text xml:space="preserve">Is this right?\nCheck the total.</text></threadedComment>',
      );
      expect(threaded).toContain(
        '<threadedComment ref="A1" dT="2026-02-03T11:00:00.000" personId="{00000000-FFFF-4000-8000-000000000001}" id="{00000000-0000-4000-8000-000001000001}" parentId="{00000000-0000-4000-8000-000001000000}">',
      );
      expect(threaded).toContain('id="{00000000-0000-4000-8000-000001000002}" parentId="{0000');
      expect(threaded).toContain('done="0"');
      expect(threaded).toContain('<threadedComment ref="C4"');
      // Ann and Bo once each, though Ann writes three comments
      const people = partOf(data, "xl/persons/person.xml");
      expect(people.match(/<person /g)).toHaveLength(2);
      expect(people).toContain(
        '<person displayName="Ann" id="{00000000-FFFF-4000-8000-000000000000}" userId="Ann" providerId="None"/>',
      );
      // the placeholder Excel keeps beside a thread, and the plain note untouched
      const legacy = partOf(data, "xl/comments1.xml");
      expect(legacy).toContain("<author>tc={00000000-0000-4000-8000-000001000000}</author>");
      expect(legacy).toContain("[Threaded comment]\n\nYour version of Excel");
      expect(legacy).toContain(
        "Comment:\n    Is this right?\n    Check the total.\nReply:\n    First reply",
      );
      expect(legacy).toContain("<author>Cy</author>");
      expect(legacy).toContain("<rPr><b/></rPr>");
      expect(partOf(data, "xl/drawings/vmlDrawing1.vml").match(/<v:shape /g)).toHaveLength(3);
      expect(partOf(data, "xl/worksheets/_rels/sheet1.xml.rels")).toContain(
        'Id="rId3" Type="http://schemas.microsoft.com/office/2017/10/relationships/threadedComment" Target="../threadedComments/threadedComment1.xml"',
      );
      expect(partOf(data, "xl/_rels/workbook.xml.rels")).toContain(
        'Type="http://schemas.microsoft.com/office/2017/10/relationships/person" Target="persons/person.xml"',
      );
      const types = partOf(data, "[Content_Types].xml");
      expect(types).toContain(
        '<Override PartName="/xl/threadedComments/threadedComment1.xml" ContentType="application/vnd.ms-excel.threadedcomments+xml"/>',
      );
      expect(types).toContain(
        '<Override PartName="/xl/persons/person.xml" ContentType="application/vnd.ms-excel.person+xml"/>',
      );
    }),
  );

  it.effect("the reader takes the thread and ignores the placeholder beside it", () =>
    Effect.gen(function* () {
      const [[back]] = yield* read(bytesOf((yield* write([original]))[0]));
      expect(back?.comments?.map((c) => [c.row, c.col, c.comment.replies.length])).toEqual([
        [0, 0, 2],
        [1, 1, 0],
        [3, 2, 0],
      ]);
      expect(back?.comments?.[0]?.comment.content).toEqual([
        para(...words("Is this right?")),
        para(...words("Check the total.")),
      ]);
    }),
  );

  it.effect("ids are derived from sheet, cell and place, so the output is reproducible", () =>
    Effect.gen(function* () {
      const other = sheet("T", [at(2, 5, said("Dee", "", ["x"], { resolved: false }))]);
      const [first] = yield* write([original, other]);
      const [second] = yield* write([original, other]);
      expect(bytesOf(first)).toEqual(bytesOf(second));
      const data = bytesOf(first);
      expect(partOf(data, "xl/threadedComments/threadedComment2.xml")).toContain(
        'id="{00000002-0005-4000-8000-000002000000}"',
      );
      expect(partOf(data, "xl/_rels/workbook.xml.rels")).toContain("persons/person.xml");
      // Ann, Bo, then Dee
      expect(partOf(data, "xl/persons/person.xml")).toContain(
        'displayName="Dee" id="{00000000-FFFF-4000-8000-000000000002}"',
      );
    }),
  );

  it.effect("a comment with no author is a person with no name, and reads back with none", () =>
    Effect.gen(function* () {
      const anonymous = sheet("S", [
        at(0, 0, said("", "2026-01-01T00:00:00.000Z", ["hm"], { resolved: false })),
      ]);
      const [content] = yield* write([anonymous]);
      expect(partOf(bytesOf(content), "xl/persons/person.xml")).toContain('displayName=""');
      const [[back]] = yield* read(bytesOf(content));
      expect(back?.comments).toEqual(anonymous.comments);
      expect(back?.comments?.[0]?.comment.author).toBeUndefined();
    }),
  );

  it.effect("a comment with no date is written without a time, and reads back with none", () =>
    Effect.gen(function* () {
      const undated = sheet("S", [
        at(0, 0, said("Ann", "", ["q"], { replies: [said("Bo", "", ["a"])] })),
      ]);
      const [content] = yield* write([undated]);
      expect(partOf(bytesOf(content), "xl/threadedComments/threadedComment1.xml")).not.toContain(
        "dT=",
      );
      const [[back]] = yield* read(bytesOf(content));
      expect(back?.comments).toEqual(undated.comments);
    }),
  );

  it.effect("narrow keeps a thread but as plain text, reporting each mark it drops", () =>
    Effect.gen(function* () {
      const marked = said("Ann", "2026-02-03T10:00:00.000Z", [], {
        resolved: true,
        replies: [
          new Comment({
            author: "Bo",
            content: [para(str("see"), space(), strong([str("this")]), softBreak(), str("now"))],
            replies: [],
          }),
        ],
      });
      const root = new Comment({
        author: marked.author,
        date: marked.date,
        resolved: true,
        content: [para(emph([str("q")]))],
        replies: marked.replies,
      });
      const doc = document([sheet("S", [at(0, 0, root), note(1, 0, [para(emph([str("kept")]))])])]);
      expect(Xlsx.is(doc)).toBe(false);
      const { document: narrowed, loss } = narrow(doc, Xlsx);
      expect(loss.entries.map((e) => [e.feature, e.action, e.path[1]])).toEqual([
        ["inline.emph", "converted", "A1"],
        ["inline.strong", "converted", "A1"],
        ["inline.softBreak", "converted", "A1"],
      ]);
      expect(Xlsx.is(narrowed)).toBe(true);
      const ws = narrowed.blocks[0];
      assert(ws !== undefined && Predicate.isTagged(ws, "Worksheet"));
      // the plain note beside it keeps its mark
      expect(ws.comments?.[1]?.comment.content).toEqual([para(emph([str("kept")]))]);
      const [content] = yield* write([ws]);
      const [[back]] = yield* read(bytesOf(content));
      expect(back?.comments).toEqual(ws.comments);
    }),
  );

  it.effect(
    "reports what a thread can't hold: initials, replies to replies, replies out of order",
    () =>
      Effect.gen(function* () {
        const nested = new Comment({
          author: "Ann",
          initials: "A",
          date: DateTime.toDateUtc(DateTime.makeUnsafe("2026-02-03T10:00:00.000Z")),
          content: [para(str("q"))],
          replies: [
            said("Bo", "2026-02-03T12:00:00.000Z", ["late"], {
              replies: [said("Cy", "2026-02-03T13:00:00.000Z", ["deep"])],
            }),
            said("Bo", "2026-02-03T11:00:00.000Z", ["early"]),
          ],
        });
        const [content, notes] = yield* write([sheet("S", [at(0, 0, nested)])]);
        expect(notes.map((d) => [d.code, d.severity, d.path])).toEqual([
          ["xlsx.commentMetadataDropped", "dropped-content", ["S"]],
          ["xlsx.threadReshaped", "converted", ["S"]],
        ]);
        const [[back]] = yield* read(bytesOf(content));
        // flat, in time order
        expect(back?.comments?.[0]?.comment.replies.map((r) => blocksText(r.content))).toEqual([
          "early",
          "late",
          "deep",
        ]);
      }),
  );

  it.effect("a workbook of plain comments gains no threaded parts", () =>
    Effect.gen(function* () {
      const [content] = yield* write([sheet("S", [note(0, 0, [para(str("a"))], "Ann")])]);
      const data = bytesOf(content);
      expect(partNames(data).filter((n) => /thread|person/i.test(n))).toEqual([]);
      expect(partOf(data, "[Content_Types].xml")).not.toMatch(/thread|person/i);
      expect(partOf(data, "xl/_rels/workbook.xml.rels")).not.toContain("person");
      expect(partOf(data, "xl/worksheets/_rels/sheet1.xml.rels")).not.toContain("threadedComment");
    }),
  );
});
