/**
 * Profile honesty, as a property (#109): for every format with a writer and a
 * reader, every document in its write profile survives `read(write(doc))` up
 * to normalisation (`../normalize.ts`). A failure means the profile claims a
 * feature (or a combination of features) the format doesn't preserve, or a
 * writer or reader bug; either way `convert` would report a lossy conversion
 * as lossless.
 *
 * A profile is a set of features, so it can't express every limit a format
 * has (a list item that holds one paragraph, headings that are always bold).
 * Those are listed per format below, each with the issue that tracks it: as
 * shape options for the generator, or as limits that erase the distinction
 * from both sides before comparing.
 *
 * The seed is fixed, so CI is deterministic; a failure prints the shrunk
 * document, both normal forms and a replay token.
 */

import { it } from "@effect/vitest";
import * as Arbitrary from "effect/Arbitrary";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Order from "effect/Order";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import { assert, describe } from "vite-plus/test";
import { type Document, type Format, trustAs } from "@thomasfosterau/effect-document";
import * as Csv from "@thomasfosterau/effect-document/csv";
import { Docx, Pptx, Xlsx } from "@thomasfosterau/effect-document/ooxml";
import * as Pdf from "@thomasfosterau/effect-document/pdf";
import * as Rtf from "@thomasfosterau/effect-document/rtf";
import { arbitraryDocument, type Family, type ShapeOptions } from "../arbitrary.ts";
import {
  mapBlockLists,
  mapBlocks,
  type Normal,
  type NormalBlock,
  type NormalComment,
  normalize,
  normalJson,
  normalizeTokens,
  type Token,
} from "../normalize.ts";

/**
 * A known limit of a format: a distinction it can't keep that its profile
 * can't express. It rewrites the normal form of both sides so that the
 * distinction is erased, and names the issue that tracks lifting it.
 */
interface Limit {
  readonly issue: string;
  readonly erase: (normal: Normal) => Normal;
}

/** A format under test, the kind of document it holds and how to generate them. */
interface Case {
  readonly format: Format<any, any>;
  readonly family: Family;
  readonly options?: ShapeOptions | undefined;
  readonly limits?: ReadonlyArray<Limit> | undefined;
  readonly runs: number;
}

/** Merge each adjacent pair of items that `join` combines (`undefined`: it doesn't). */
const mergeAdjacent =
  <A>(join: (a: A, b: A) => A | undefined) =>
  (items: ReadonlyArray<A>): ReadonlyArray<A> =>
    items.reduce<Array<A>>((out, item) => {
      const last = out.at(-1);
      const joined = last === undefined ? undefined : join(last, item);
      if (joined === undefined) out.push(item);
      else out[out.length - 1] = joined;
      return out;
    }, []);

/** Adjacent bullet lists are one list: the format has no container to end one, and no numbering to restart. */
const adjacentBulletLists = (normal: Normal): Normal =>
  mapBlockLists(
    normal,
    mergeAdjacent<NormalBlock>((a, b) =>
      Predicate.isTagged(a, "Bullets") && Predicate.isTagged(b, "Bullets")
        ? { ...a, items: [...a.items, ...b.items] }
        : undefined,
    ),
  );

/** In a title placeholder, headings and paragraphs are one: the placeholder is the slide's heading. */
const titleHeadings = (normal: Normal): Normal =>
  mapBlocks(normal, (b) =>
    Predicate.isTagged(b, "Slides")
      ? {
          ...b,
          slides: b.slides.map((shapes) =>
            shapes.map((shape) =>
              shape.placeholder === "title" || shape.placeholder === "ctrTitle"
                ? {
                    ...shape,
                    content: shape.content.map((c): NormalBlock =>
                      Predicate.isTagged(c, "Header") ? { _tag: "Para", text: c.text } : c,
                    ),
                  }
                : shape,
            ),
          ),
        }
      : b,
  );

/** The marks a token carries, as a list. */
const marksOf = (t: Token): ReadonlyArray<string> =>
  Predicate.isTagged(t, "Word") || Predicate.isTagged(t, "Code")
    ? t.marks.split("|").filter((m) => m !== "")
    : [];

/**
 * A heading without an id whose whole text is one span reads as the heading's
 * id: a bookmark around a whole heading paragraph is its id (#184).
 */
const wholeSpanHeadings = (normal: Normal): Normal =>
  mapBlocks(normal, (b) => {
    if (!Predicate.isTagged(b, "Header") || b.id !== undefined) return b;
    const marked = b.text.filter(
      (t) => !Predicate.isTagged(t, "Space") && !Predicate.isTagged(t, "Break"),
    );
    const span = marksOf(marked[0] ?? { _tag: "Space" }).find((m) => m.startsWith("span:"));
    if (span === undefined || !marked.every((t) => marksOf(t).includes(span))) return b;
    return {
      ...b,
      id: span.slice("span:".length),
      text: normalizeTokens(
        b.text.map((t) =>
          Predicate.isTagged(t, "Word") || Predicate.isTagged(t, "Code")
            ? {
                ...t,
                marks: marksOf(t)
                  .filter((m) => m !== span)
                  .join("|"),
              }
            : t,
        ),
      ),
    };
  });

/** A normal comment's `meta` (`author|initials|date|resolved`) as its four fields. */
const metaFields = (c: NormalComment): readonly [string, string, string, string] => {
  const [author = "", initials = "", date = "", resolved = ""] = c.meta.split("|");
  return [author, initials, date, resolved];
};

/** A comment's replies at any depth, in thread order. */
const replyMembers = (c: NormalComment): ReadonlyArray<NormalComment> =>
  c.replies.flatMap((r) => [r, ...replyMembers(r)]);

/** A comment without its initials, its replies, and, unless `keepDate`, its date. */
const bareComment = (c: NormalComment, keepDate: boolean): NormalComment => {
  const [author, , date, resolved] = metaFields(c);
  return { ...c, meta: [author, "", keepDate ? date : "", resolved].join("|"), replies: [] };
};

/** Order of comments by their time (an ISO string; none sorts first), the order the XLSX reader gives replies. */
const byTime = Order.mapInput(Order.String, (c: NormalComment) => metaFields(c)[2]);

/**
 * What a comment in a workbook can't keep (#67), erased from both sides:
 * initials (Excel's notes and threaded comments have nowhere for them); the
 * date of a comment that is no thread (a legacy note holds none); and the
 * shape of a thread, which Excel keeps flat and ordered by time (a reply to a
 * reply follows its reply's place in the thread, and the replies are read back
 * in time order, those without a time first). The writer reports each as a
 * diagnostic.
 */
const flatThreads = (normal: Normal): Normal =>
  normal.map((b) =>
    Predicate.isTagged(b, "Sheet")
      ? {
          ...b,
          comments: b.comments.map(({ cell, comment }) => ({
            cell,
            comment: {
              ...bareComment(
                comment,
                Arr.isReadonlyArrayNonEmpty(comment.replies) || metaFields(comment)[3] !== "",
              ),
              replies: Arr.sort(
                replyMembers(comment).map((r) => bareComment(r, true)),
                byTime,
              ),
            },
          })),
        }
      : b,
  );

const CASES: ReadonlyArray<Case> = [
  // CSV carries a type per column, not per cell (#88).
  { format: Csv.format, family: "sheet", options: { columnTyped: true }, runs: 100 },
  { format: Csv.tsvFormat, family: "sheet", options: { columnTyped: true }, runs: 50 },
  {
    format: Xlsx.format,
    family: "sheet",
    limits: [{ issue: "#67", erase: flatThreads }],
    runs: 100,
  },
  {
    format: Docx.format,
    family: "prose",
    limits: [{ issue: "#184", erase: wholeSpanHeadings }],
    runs: 100,
  },
  {
    format: Pptx.format,
    family: "deck",
    limits: [
      // DrawingML has no list container: adjacent bullet lists read back as one.
      { issue: "#196", erase: adjacentBulletLists },
      // A title placeholder's text reads back as level-1 headings.
      { issue: "#196", erase: titleHeadings },
    ],
    runs: 100,
  },
  {
    format: Rtf.format,
    family: "prose",
    runs: 100,
  },
  {
    format: Pdf.format,
    family: "prose",
    // The writer tags its output and the reader takes the structure from the
    // tags (#198), so headings keep their levels, paragraphs and lists their
    // breaks, list items their paragraphs, and a line's trailing hyphen its
    // space (only a soft hyphen joins a tagged word across lines).
    runs: 50,
  },
];

describe("every write-profile document round-trips (#109)", () => {
  CASES.forEach(({ format, family, options, runs, limits = [] }) => {
    const normal = (doc: Document): string =>
      normalJson(limits.reduce((n, l) => l.erase(n), normalize(doc)));
    const roundTrip = (doc: Document) =>
      Effect.flatMap(format.writer!.write(trustAs(doc)), (content) => format.reader!.read(content));
    /** Both normal forms of a falsified check's shrunk document. */
    const explain = (result: Arbitrary.CheckResult<Document, unknown>) =>
      Effect.gen(function* () {
        if (!Predicate.isTagged(result, "Falsified")) return undefined;
        const doc = result.shrunkInput;
        const back = yield* Effect.result(roundTrip(doc));
        const actual = Result.match(back, { onSuccess: normal, onFailure: String });
        return `\nexpected ${normal(doc)}\nactual   ${actual}`;
      });
    it.effect(
      `${format.id}: read(write(doc)) normalises to doc`,
      () =>
        Effect.gen(function* () {
          const result = yield* Arbitrary.checkEffect(
            arbitraryDocument(format.writeProfile, family, options),
            (doc) => Effect.map(roundTrip(doc), (back) => normal(back) === normal(doc)),
            { runs, seed: 109, size: 10 },
          );
          assert.strictEqual(
            Arbitrary.formatCheckFailure(result),
            undefined,
            yield* explain(result),
          );
          // (generous: a hundred round trips through a format, slower still under coverage)
        }),
      120_000,
    );
  });
});
