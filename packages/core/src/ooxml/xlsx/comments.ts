/**
 * Cell comments (#67): a worksheet's legacy notes (`xl/commentsN.xml`, shown
 * with a VML drawing) and, when present, Excel's threaded comments
 * (`xl/threadedComments/threadedCommentN.xml`, with the workbook's
 * `xl/persons/person.xml` naming their authors), read as the sheet's
 * `CellComment`s; and a sheet's comments written back as legacy notes.
 *
 * A cell with a threaded comment takes the thread (its root, then its replies
 * by time, `done` as resolved): the legacy note Excel keeps beside it ("[Threaded
 * comment] Your version of Excel allows you to read this threaded comment…")
 * is only a placeholder for older programs, and is not read as a second
 * comment. A comment's body is one paragraph per line of its text.
 */

import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Predicate from "effect/Predicate";
import * as Rec from "effect/Record";
import type * as Types from "effect/Types";
import * as DateTime from "effect/DateTime";
import * as Result from "effect/Result";
import {
  type Block,
  CellComment,
  Comment,
  type Diagnostic,
  type Inline,
  Para,
  softBreak,
  str,
  blocksToText,
} from "../../index.ts";
import type { OpcReader, Relationship } from "../shared/index.ts";
import { parseA1, toA1 } from "./a1.ts";
import { decodeXstring } from "./cellText.ts";
import { escapeXstring } from "./cellTypes.ts";
import { MAX_COLUMNS } from "./layout.ts";
import { inlinesOfText, linesOfRichText, richTextRunsXml } from "./richText.ts";
import { findChild, findChildren, getAttr, type XmlElement } from "./xml.ts";

/** The relationship type of a sheet's legacy comments part. */
export const REL_COMMENTS =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments";
/** The relationship type of a sheet's VML drawing, the shapes Excel shows its legacy notes with. */
export const REL_VML_DRAWING =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/vmlDrawing";
/** The relationship type of a sheet's threaded comments part. */
const REL_THREADED_COMMENTS =
  "http://schemas.microsoft.com/office/2017/10/relationships/threadedComment";
/** The relationship type of the workbook's list of the people who comment. */
export const REL_PERSONS = "http://schemas.microsoft.com/office/2017/10/relationships/person";

/** The content type of a legacy comments part. */
export const CT_COMMENTS =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.comments+xml";
/** The content type of a VML drawing part (declared for the `vml` extension). */
export const CT_VML_DRAWING = "application/vnd.openxmlformats-officedocument.vmlDrawing";

/** The most rows a worksheet has. */
const MAX_ROWS = 1_048_576;

// ============================================================================
// Reading
// ============================================================================

/** A comment found in a part, with the cell reference its part gave it. */
interface Found {
  readonly ref: string;
  readonly comment: Comment;
}

/** `props` of a comment with the keys it has: an absent value is no key. */
const commentOf = (fields: {
  readonly author: Option.Option<string>;
  readonly date: Option.Option<Date>;
  readonly resolved: boolean;
  readonly lines: ReadonlyArray<ReadonlyArray<Inline>>;
  readonly replies: ReadonlyArray<Comment>;
}): Comment => {
  const props: Types.Mutable<ConstructorParameters<typeof Comment>[0]> = {
    content: bodyOf(fields.lines),
    replies: fields.replies,
  };
  if (Option.isSome(fields.author)) props.author = fields.author.value;
  if (Option.isSome(fields.date)) props.date = fields.date.value;
  if (fields.resolved) props.resolved = true;
  return new Comment(props);
};

/**
 * A body from its lines: a paragraph each, and none for a text that is a
 * single empty line (an empty comment).
 */
const bodyOf = (lines: ReadonlyArray<ReadonlyArray<Inline>>): ReadonlyArray<Block> =>
  lines.length === 1 && Arr.isReadonlyArrayEmpty(lines[0] ?? [])
    ? []
    : lines.map((content) => new Para({ content }));

/** The legacy comments of a `<comments>` part: each with its author, in file order. */
const legacyComments = (root: XmlElement): ReadonlyArray<Found> => {
  const authors = findChildren(findChild(root, "authors") ?? root, "author").map((a) =>
    decodeXstring(a.text),
  );
  const list = findChild(root, "commentList");
  return (list === undefined ? [] : findChildren(list, "comment")).map((el) => {
    const author = Option.filter(
      Option.fromUndefinedOr(authors[Number(getAttr(el, "authorId"))]),
      (name) => name !== "",
    );
    const text = findChild(el, "text");
    return {
      ref: getAttr(el, "ref") ?? "",
      comment: commentOf({
        author,
        date: Option.none(),
        resolved: false,
        lines: text === undefined ? [[]] : linesOfRichText(text),
        replies: [],
      }),
    };
  });
};

/** A `<threadedComment>`, as its part gives it. */
interface Threaded {
  readonly id: string;
  readonly parentId: Option.Option<string>;
  readonly ref: string;
  readonly time: string;
  readonly done: boolean;
  readonly person: Option.Option<string>;
  readonly text: string;
}

const threadedOf = (el: XmlElement): Threaded => ({
  id: getAttr(el, "id") ?? "",
  parentId: Option.filter(Option.fromUndefinedOr(getAttr(el, "parentId")), (id) => id !== ""),
  ref: getAttr(el, "ref") ?? "",
  time: getAttr(el, "dT") ?? "",
  done: ["1", "true"].includes(getAttr(el, "done") ?? ""),
  person: Option.fromUndefinedOr(getAttr(el, "personId")),
  text: decodeXstring(findChild(el, "text")?.text ?? ""),
});

/** A zone Excel's `dT` leaves off (`2021-05-16T11:23:14.07`) is UTC; an unreadable time is none. */
const timeOf = (dT: string): Option.Option<Date> =>
  Option.map(DateTime.make(/(?:Z|[+-]\d\d:\d\d)$/i.test(dT) ? dT : `${dT}Z`), DateTime.toDateUtc);

/** A line-per-paragraph body from plain text (a threaded comment's). */
const plainLines = (text: string): ReadonlyArray<ReadonlyArray<Inline>> =>
  text.split(/\r\n|\r|\n/).map(inlinesOfText);

/** A threaded comment as a comment with the given replies. */
const threadedComment = (
  t: Threaded,
  replies: ReadonlyArray<Comment>,
  persons: Readonly<Record<string, string>>,
): Comment =>
  commentOf({
    author: Option.flatMap(t.person, (id) => Rec.get(persons, id)),
    date: timeOf(t.time),
    resolved: t.done,
    lines: plainLines(t.text),
    replies,
  });

/**
 * The threads of a `<ThreadedComments>` part, in order of first appearance of
 * their cell: a cell's root is its comment without a `parentId`, and every
 * other comment of the cell is a reply to it, in time order (Excel keeps a
 * thread flat). A cell with only replies takes its earliest as the root.
 */
const threadedComments = (
  root: XmlElement,
  persons: Readonly<Record<string, string>>,
): ReadonlyArray<Found> => {
  const all = findChildren(root, "threadedComment").map(threadedOf);
  const refs = Arr.dedupe(all.map((t) => t.ref));
  return refs.flatMap((ref) => {
    const thread = Arr.sort(
      all.filter((t) => t.ref === ref),
      timeOrder,
    );
    const head =
      thread.find((t) => Option.isNone(t.parentId)) ?? Option.getOrUndefined(Arr.head(thread));
    if (head === undefined) return [];
    const replies = thread.filter((t) => t !== head).map((t) => threadedComment(t, [], persons));
    return [{ ref, comment: threadedComment(head, replies, persons) }];
  });
};

/** Threaded comments by their time (ISO strings order as the times do; the sort is stable). */
const timeOrder = Order.mapInput(Order.String, (t: Threaded) => t.time);

/** The people of the workbook's `person.xml`, by id: their display names. */
export const readPersons = (root: XmlElement): Readonly<Record<string, string>> =>
  Rec.fromEntries(
    findChildren(root, "person").flatMap((p) => {
      const id = getAttr(p, "id");
      const name = getAttr(p, "displayName");
      return id === undefined || name === undefined ? [] : [[id, name] as const];
    }),
  );

/** What reading a sheet's comments found: its comments, row-major, and what it left out. */
export interface SheetCommentsRead {
  readonly comments: ReadonlyArray<CellComment>;
  /** One note per part or comment that could not be read (reported as a diagnostic). */
  readonly notes: ReadonlyArray<string>;
}

/** What reading needs of the package: its parts, and the workbook's people (read when a thread needs them). */
export interface CommentSources {
  readonly pkg: OpcReader;
  readonly persons: () => Readonly<Record<string, string>>;
}

/** The part `rel` names, parsed, or the note that it is missing. */
const partOf = (pkg: OpcReader, rel: Relationship): Result.Result<XmlElement, string> => {
  const root = pkg.xml(rel.target);
  return root === null ? Result.fail(`part ${rel.target} is missing`) : Result.succeed(root);
};

/**
 * A sheet's comments, from its part's relationships `rels`: the legacy
 * comments part and the threaded one, a cell's thread replacing its legacy
 * note. Both are read only when the sheet relates to them, so a sheet without
 * comments costs nothing here. A malformed part throws (an `XmlPartError`,
 * for the reader to map); a missing part, or a comment whose `ref` is not a
 * cell, is left out and noted.
 */
export const readSheetComments = (
  sources: CommentSources,
  rels: ReadonlyArray<Relationship>,
): SheetCommentsRead => {
  const internal = rels.filter((r) => !r.external);
  const legacyRel = internal.find((r) => r.type === REL_COMMENTS);
  const threadedRel = internal.find((r) => r.type === REL_THREADED_COMMENTS);
  if (legacyRel === undefined && threadedRel === undefined) return { comments: [], notes: [] };
  const legacy = Option.fromUndefinedOr(legacyRel).pipe(Option.map((r) => partOf(sources.pkg, r)));
  const threaded = Option.fromUndefinedOr(threadedRel).pipe(
    Option.map((r) => partOf(sources.pkg, r)),
  );
  const missing = [legacy, threaded].flatMap((part) =>
    Option.isSome(part) && Result.isFailure(part.value) ? [part.value.failure] : [],
  );
  const threads = Option.match(threaded, {
    onNone: () => [],
    onSome: (part) =>
      Result.isSuccess(part) ? threadedComments(part.success, sources.persons()) : [],
  });
  const covered = threads.map((t) => t.ref);
  const notes = Option.match(legacy, {
    onNone: () => [],
    onSome: (part) =>
      Result.isSuccess(part)
        ? legacyComments(part.success).filter((f) => !covered.includes(f.ref))
        : [],
  });
  const anchored = [...notes, ...threads].map((found) => ({
    found,
    at: parseA1(found.ref),
  }));
  const unplaced = anchored.flatMap(({ found, at }) =>
    at === null ? [`comment on "${found.ref}", which is not a cell`] : [],
  );
  const comments = anchored.flatMap(({ found, at }) =>
    at === null ? [] : [new CellComment({ row: at.row, col: at.col, comment: found.comment })],
  );
  return {
    comments: Arr.sort(comments, byPosition),
    notes: [...missing, ...unplaced],
  };
};

/** Row-major order of a sheet's comments (the sort is stable). */
const byPosition = Order.combine(
  Order.mapInput(Order.Number, (c: CellComment) => c.row),
  Order.mapInput(Order.Number, (c: CellComment) => c.col),
);

/** The writer's diagnostic for the comments of `sheet` whose date or initials a legacy note can't hold. */
export const unkeptDiagnostic = (sheet: string, addresses: ReadonlyArray<string>): Diagnostic => ({
  format: "xlsx",
  stage: "write",
  code: "xlsx.commentMetadataDropped",
  severity: "dropped-content",
  path: [sheet],
  detail: `the date or initials of the comment(s) on ${addresses.join(", ")} in "${sheet}" not written: a legacy note holds an author and text only`,
});

/** The reader's diagnostic for comments of `sheet` it could not read. */
export const commentsDiagnostic = (sheet: string, notes: ReadonlyArray<string>): Diagnostic => ({
  format: "xlsx",
  stage: "read",
  code: "xlsx.commentDropped",
  severity: "dropped-content",
  path: [sheet],
  detail: `comments of "${sheet}" left out: ${notes.join("; ")}`,
});

// ============================================================================
// Writing
// ============================================================================

/** A sheet's comments as the parts Excel needs to show them. */
export interface CommentsXml {
  /** `xl/commentsN.xml`. */
  readonly comments: string;
  /** `xl/drawings/vmlDrawingN.vml`. */
  readonly vml: string;
  /** The cells (A1 addresses) of comments with a date or initials, which a legacy note can't hold. */
  readonly unkept: ReadonlyArray<string>;
}

/** A comment's text: its paragraphs, one per line, as the runs of a `<text>`. */
const textXml = (content: ReadonlyArray<Block>): string =>
  richTextRunsXml(
    content.flatMap((block, i): ReadonlyArray<Inline> => {
      const inlines =
        Predicate.isTagged(block, "Para") || Predicate.isTagged(block, "Plain")
          ? block.content
          : [str(blocksToText([block]))];
      return i === 0 ? inlines : [softBreak(), ...inlines];
    }),
    escapeXstring,
  );

/** The shape Excel shows a note with, hidden until the cell is hovered. */
const shapeXml = (dataId: number, n: number, row: number, col: number): string => {
  // the note's box: two columns wide and four rows tall, to the right of and
  // just above its cell, as Excel places a new one
  const top = Math.max(row - 1, 0);
  return (
    `<v:shape id="_x0000_s${dataId * 1024 + n}" type="#_x0000_t202" ` +
    `style='position:absolute;margin-left:80pt;margin-top:2pt;width:108pt;height:60pt;z-index:${n};visibility:hidden' ` +
    `fillcolor="#ffffe1" o:insetmode="auto">` +
    `<v:fill color2="#ffffe1"/>` +
    `<v:shadow on="t" color="black" obscured="t"/>` +
    `<v:path o:connecttype="none"/>` +
    `<v:textbox style='mso-direction-alt:auto'><div style='text-align:left'></div></v:textbox>` +
    `<x:ClientData ObjectType="Note">` +
    `<x:MoveWithCells/><x:SizeWithCells/>` +
    `<x:Anchor>${col + 1}, 15, ${top}, 10, ${col + 3}, 15, ${top + 4}, 4</x:Anchor>` +
    `<x:AutoFill>False</x:AutoFill>` +
    `<x:Row>${row}</x:Row><x:Column>${col}</x:Column>` +
    `</x:ClientData></v:shape>`
  );
};

/** The VML drawing of a sheet's notes (the form Excel, openpyxl and XlsxWriter write), `dataId` being the drawing's number in the workbook. */
const vmlXml = (dataId: number, positions: ReadonlyArray<readonly [row: number, col: number]>) =>
  `<xml xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel">` +
  `<o:shapelayout v:ext="edit"><o:idmap v:ext="edit" data="${dataId}"/></o:shapelayout>` +
  `<v:shapetype id="_x0000_t202" coordsize="21600,21600" o:spt="202" path="m,l,21600r21600,l21600,xe">` +
  `<v:stroke joinstyle="miter"/><v:path gradientshapeok="t" o:connecttype="rect"/></v:shapetype>` +
  positions.map(([row, col], i) => shapeXml(dataId, i + 1, row, col)).join("") +
  `</xml>`;

/** Why a comment can't be written as a legacy note, if it can't. */
const unwritable = (c: CellComment): Option.Option<string> => {
  const at = toA1(c.col, c.row);
  if (c.col >= MAX_COLUMNS || c.row >= MAX_ROWS)
    return Option.some(
      `a comment on ${at}, outside the sheet's ${MAX_COLUMNS} columns and ${MAX_ROWS} rows`,
    );
  if (Arr.isReadonlyArrayNonEmpty(c.comment.replies) || c.comment.resolved !== undefined)
    return Option.some(
      `the comment on ${at} is a thread (replies or a resolved mark), which is not written yet: narrow the document to the Xlsx profile first, which folds the thread into the comment`,
    );
  return Option.none();
};

/**
 * A sheet's comments as legacy notes: the `<comments>` part (authors listed
 * once each in order of first use, a comment without an author under the empty
 * name) and the VML drawing that shows them, `dataId` (from 1) being the
 * drawing's number in the workbook. The comments are written in row-major
 * order, as Excel does. A failure says what can't be written: a thread, a
 * cell outside the sheet, or two comments on one cell.
 */
export const commentsXml = (
  comments: ReadonlyArray<CellComment>,
  dataId: number,
): Result.Result<CommentsXml, string> => {
  const [problem] = comments.flatMap((c) => Option.toArray(unwritable(c)));
  if (problem !== undefined) return Result.fail(problem);
  const sorted = Arr.sort(comments, byPosition);
  const twice = sorted.find((c, i) => {
    const before = sorted[i - 1];
    return before !== undefined && before.row === c.row && before.col === c.col;
  });
  if (twice !== undefined)
    return Result.fail(`two comments on ${toA1(twice.col, twice.row)}: a cell has one`);
  const authors = Arr.dedupe(sorted.map((c) => c.comment.author ?? ""));
  const list = sorted
    .map(
      (c) =>
        `<comment ref="${toA1(c.col, c.row)}" authorId="${authors.indexOf(c.comment.author ?? "")}">` +
        `<text>${textXml(c.comment.content)}</text></comment>`,
    )
    .join("");
  return Result.succeed({
    comments:
      `<comments xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
      `<authors>${authors.map((a) => `<author>${escapeXstring(a)}</author>`).join("")}</authors>` +
      `<commentList>${list}</commentList></comments>`,
    unkept: sorted
      .filter((c) => c.comment.date !== undefined || c.comment.initials !== undefined)
      .map((c) => toA1(c.col, c.row)),
    vml: vmlXml(
      dataId,
      sorted.map((c) => [c.row, c.col] as const),
    ),
  });
};
