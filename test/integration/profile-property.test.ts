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

import * as Arbitrary from "effect/Arbitrary";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import { assert, describe, test } from "vite-plus/test";
import { type Document, type Format, trustAs } from "@thomasfosterau/effect-document";
import * as Csv from "@thomasfosterau/effect-csv";
import { Docx, Pptx, Xlsx } from "@thomasfosterau/effect-ooxml";
import * as Pdf from "@thomasfosterau/effect-pdf";
import * as Rtf from "@thomasfosterau/effect-rtf";
import { arbitraryDocument, type Family, type ShapeOptions } from "../arbitrary.ts";
import {
  mapBlockLists,
  mapBlocks,
  mapTokens,
  type Normal,
  type NormalBlock,
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

/** Adjacent lists of the same kind are one list: the format has no container to end a list. */
const adjacentLists = (normal: Normal): Normal =>
  mapBlockLists(
    normal,
    mergeAdjacent<NormalBlock>((a, b) =>
      (Predicate.isTagged(a, "Bullets") && Predicate.isTagged(b, "Bullets")) ||
      (Predicate.isTagged(a, "Ordered") && Predicate.isTagged(b, "Ordered"))
        ? { ...a, items: [...a.items, ...b.items] }
        : undefined,
    ),
  );

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

/** Whether `token` is a word ending in a hyphen. */
const endsWithHyphen = (token: Token | undefined): boolean =>
  token !== undefined && Predicate.isTagged(token, "Word") && token.text.endsWith("-");

/** No space after a word ending in "-", and the words either side joined if their marks match. */
const hyphenatedWords = (normal: Normal): Normal =>
  mapTokens(normal, (tokens) =>
    normalizeTokens(
      tokens.filter((t, i) => !(Predicate.isTagged(t, "Space") && endsWithHyphen(tokens[i - 1]))),
    ),
  );

const CASES: ReadonlyArray<Case> = [
  // CSV carries a type per column, not per cell (#88).
  { format: Csv.format, family: "sheet", options: { columnTyped: true }, runs: 100 },
  { format: Csv.tsvFormat, family: "sheet", options: { columnTyped: true }, runs: 50 },
  { format: Xlsx.format, family: "sheet", runs: 100 },
  { format: Docx.format, family: "prose", runs: 100 },
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
    // breaks, and list items their paragraphs.
    limits: [
      // A line that ends in a hyphen is a word broken across lines.
      { issue: "#198", erase: hyphenatedWords },
    ],
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
    const explain = async (
      result: Arbitrary.CheckResult<Document, unknown>,
    ): Promise<string | undefined> => {
      if (!Predicate.isTagged(result, "Falsified")) return undefined;
      const doc = result.shrunkInput;
      const back = await Effect.runPromise(Effect.result(roundTrip(doc)));
      const actual = Result.match(back, { onSuccess: normal, onFailure: String });
      return `\nexpected ${normal(doc)}\nactual   ${actual}`;
    };
    test(`${format.id}: read(write(doc)) normalises to doc`, async () => {
      const result = await Effect.runPromise(
        Arbitrary.checkEffect(
          arbitraryDocument(format.writeProfile, family, options),
          (doc) => Effect.map(roundTrip(doc), (back) => normal(back) === normal(doc)),
          { runs, seed: 109, size: 10 },
        ),
      );
      assert.strictEqual(Arbitrary.formatCheckFailure(result), undefined, await explain(result));
    });
  });
});
