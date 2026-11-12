import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Rec from "effect/Record";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { assert, describe, expect, test } from "vite-plus/test";
import {
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
  Effect.runSync(
    collectDiagnostics(makeXlsxWriter().write(trustAs<XlsxFeature>(document(sheets)))),
  );

/** The sheets `data` reads as, with the diagnostics the read reported. */
const read = (data: Uint8Array): readonly [ReadonlyArray<Worksheet>, ReadonlyArray<Diagnostic>] => {
  const [doc, found] = Effect.runSync(collectDiagnostics(makeXlsxReader().read(bytes(data))));
  return [doc.blocks.filter((b): b is Worksheet => Predicate.isTagged(b, "Worksheet")), found];
};

/** Why the writer refuses a sheet "S" with these comments. */
const refusal = (comments: ReadonlyArray<CellComment>) =>
  Effect.runSync(
    Effect.flip(makeXlsxWriter().write(trustAs<XlsxFeature>(document([sheet("S", comments)])))),
  ).reason;

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

  test("round-trip author, several lines and marked runs", () => {
    const [content, notes] = write([original]);
    expect(notes).toEqual([]);
    const [[back], found] = read(bytesOf(content));
    expect(found).toEqual([]);
    expect(back?.comments).toEqual(original.comments);
    expect(Xlsx.is(document([original]))).toBe(true);
  });

  test("writes the comments part, the VML drawing, the relationships and the content types", () => {
    const [content] = write([original]);
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
  });

  test("a sheet without comments writes none of it", () => {
    const [content] = write([worksheet("S", [["a"]])]);
    const data = bytesOf(content);
    expect(Object.keys(unzipSync(data)).filter((n) => /comments|vml/.test(n))).toEqual([]);
    expect(partOf(data, "[Content_Types].xml")).not.toContain("vml");
    expect(partOf(data, "xl/worksheets/sheet1.xml")).not.toContain("legacyDrawing");
  });

  test("the output is byte-for-byte reproducible", () => {
    const first = bytesOf(write([original])[0]);
    const second = bytesOf(write([original])[0]);
    expect(first).toEqual(second);
  });

  test("comments on two sheets are numbered in order, sharing a relationship file with hyperlinks", () => {
    const plain = worksheet("Plain", [["x"]]);
    const [content] = write([
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
    const [sheets] = read(data);
    expect(sheets.map((s) => s.comments?.length)).toEqual([undefined, 1, 1]);
    expect(sheets[2]?.comments?.[0]).toEqual(note(2, 2, [para(str("c"))], "Cy"));
  });

  test("a comment on a blank cell past the rows round-trips", () => {
    const far = sheet("S", [note(30, 20, [para(str("far"))])]);
    const [[back]] = read(bytesOf(write([far])[0]));
    expect(back?.comments).toEqual(far.comments);
  });

  test("the writer refuses what it can't write: a thread, two comments on a cell, a cell outside the sheet", () => {
    const thread = new CellComment({
      row: 0,
      col: 0,
      comment: new Comment({
        content: [para(str("q"))],
        replies: [new Comment({ content: [para(str("a"))], replies: [] })],
      }),
    });
    expect(refusal([thread])).toContain('worksheet "S": the comment on A1 is a thread');
    expect(refusal([note(0, 0, [para(str("a"))]), note(0, 0, [para(str("b"))])])).toContain(
      "two comments on A1",
    );
    expect(refusal([note(0, 16_384, [para(str("a"))])])).toContain("outside the sheet");
  });

  test("narrow folds a thread for the write profile, which round-trips", () => {
    const thread = new CellComment({
      row: 0,
      col: 0,
      comment: new Comment({
        author: "Ann",
        resolved: true,
        content: [para(str("q"))],
        replies: [new Comment({ author: "Bo", content: [para(str("a"))], replies: [] })],
      }),
    });
    const doc = document([sheet("S", [thread])]);
    expect(XlsxRead.is(doc)).toBe(true);
    expect(Xlsx.is(doc)).toBe(false);
    const { document: narrowed, loss } = narrow(doc, Xlsx);
    expect(loss.entries.map((e) => [e.feature, e.action, e.path])).toEqual([
      ["review.threads", "converted", [0, "A1"]],
    ]);
    const narrowedSheet = narrowed.blocks[0];
    assert(narrowedSheet !== undefined && Predicate.isTagged(narrowedSheet, "Worksheet"));
    const [content] = write([narrowedSheet]);
    const [[back]] = read(bytesOf(content));
    expect(back?.comments?.[0]?.comment.content.map((p) => p._tag)).toEqual(["Para", "Para"]);
    expect(back?.comments?.[0]?.comment.author).toBe("Ann");
  });

  test("a line break inside a paragraph is read back as a new paragraph", () => {
    const wrapped = sheet("S", [note(0, 0, [para(str("a"), softBreak(), str("b"))])]);
    const [[back]] = read(bytesOf(write([wrapped])[0]));
    expect(back?.comments?.[0]?.comment.content).toEqual([para(str("a")), para(str("b"))]);
  });
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

  test("a cell with a thread takes it: root, replies by time, resolved, date and author", () => {
    const [[back], found] = read(threaded);
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
    expect(thread.comment.replies[0]?.content).toEqual([para(str("First"), space(), str("reply"))]);
    expect(XlsxRead.is(document(back === undefined ? [] : [back]))).toBe(true);
    expect(Xlsx.is(document(back === undefined ? [] : [back]))).toBe(false);
  });

  test("a sheet with only a legacy placeholder and no threaded part reads it as a note", () => {
    const data = workbook({ "xl/comments1.xml": LEGACY }, [
      ["rId1", `${REL}/comments`, "../comments1.xml"],
    ]);
    const [[back]] = read(data);
    expect(back?.comments?.map((c) => [c.row, c.col])).toEqual([
      [0, 0],
      [1, 1],
    ]);
  });

  test("an unknown person leaves the author off; a missing part is noted and the rest read", () => {
    const data = workbook({ "xl/threadedComments/threadedComment1.xml": THREADED }, [
      ["rId1", `${REL}/comments`, "../comments1.xml"],
      ["rId2", `${MS}/threadedComment`, "../threadedComments/threadedComment1.xml"],
    ]);
    const [[back], found] = read(data);
    expect(back?.comments?.[0]?.comment.author).toBeUndefined();
    expect(back?.comments?.[0]?.comment.replies).toHaveLength(2);
    expect(found.map((d) => [d.code, d.severity, d.path])).toEqual([
      ["xlsx.commentDropped", "dropped-content", ["S"]],
    ]);
    expect(found[0]?.detail).toContain("xl/comments1.xml is missing");
  });

  test("a comment whose ref is not a cell is left out and reported", () => {
    const data = workbook(
      {
        "xl/comments1.xml": `<comments xmlns="${NS}"><authors><author>A</author></authors><commentList><comment ref="nope" authorId="0"><text><t>x</t></text></comment><comment ref="C3" authorId="0"><text><t>y</t></text></comment></commentList></comments>`,
      },
      [["rId1", `${REL}/comments`, "../comments1.xml"]],
    );
    const [[back], found] = read(data);
    expect(back?.comments?.map((c) => [c.row, c.col])).toEqual([[2, 2]]);
    expect(found[0]?.detail).toContain('"nope"');
  });

  test("a malformed comments part fails the read, positioned at the sheet and part", () => {
    const data = workbook({ "xl/comments1.xml": "<comments><authors></comments>" }, [
      ["rId1", `${REL}/comments`, "../comments1.xml"],
    ]);
    const error = Effect.runSync(Effect.flip(makeXlsxReader().read(bytes(data))));
    expect(error.code).toBe("MalformedXml");
    expect(error.position?.sheet).toBe("S");
    expect(error.position?.part).toBe("xl/comments1.xml");
  });

  test("a preview read keeps the comments on the rows it kept", () => {
    const [content] = write([
      withSheetComments(worksheet("S", [["a"], ["b"], ["c"]]), [
        note(0, 0, [para(str("kept"))]),
        note(2, 0, [para(str("cut"))]),
      ]),
    ]);
    const [doc] = Effect.runSync(
      collectDiagnostics(makeXlsxReader({ maxRows: 2 }).read(bytes(bytesOf(content)))),
    );
    const ws = doc.blocks[0];
    assert(ws !== undefined && Predicate.isTagged(ws, "Worksheet"));
    expect(ws.comments?.map((c) => c.row)).toEqual([0]);
  });
});
