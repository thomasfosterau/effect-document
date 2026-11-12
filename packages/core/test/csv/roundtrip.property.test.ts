/**
 * `read(write(grid))` on raw string grids (#92 item 3): any grid of fields,
 * written under each quoting mode that can write every field, scans back to
 * itself, whole or streamed in chunks split anywhere.
 */

import { it } from "@effect/vitest";
import * as Arbitrary from "effect/Arbitrary";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Equivalence from "effect/Equivalence";
import * as Order from "effect/Order";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { assert, describe } from "vite-plus/test";
import {
  type CsvDialect,
  type CsvQuoting,
  makeCsvWriter,
  scanCsv,
  scanCsvStream,
  StandardDialect,
  TsvDialect,
} from "../../src/csv/index.ts";
import { document, trustAs, worksheetFromRows } from "../../src/index.ts";

/** Characters that stress the syntax: separators, quotes, line breaks, edge spaces, a non-ASCII letter. */
const CHARS = Schema.Literals([",", ";", "\t", '"', "\n", "\r", " ", "a", "b", "é", "1"]);
const Field = Schema.Array(CHARS);
const Grid = Schema.Array(Schema.NonEmptyArray(Field));
const grids = Arbitrary.map(Arbitrary.schema(Grid), (g) =>
  g.map((row) => row.map((f) => f.join(""))),
);

/** Where to cut a text into stream chunks, as fractions of its length. */
const cuts = Arbitrary.schema(
  Schema.Array(Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }))),
);

/** The text a writer gives for `grid`, every field a text cell. */
const written = (
  grid: ReadonlyArray<ReadonlyArray<string>>,
  dialect: CsvDialect,
  quoting: CsvQuoting,
) =>
  Effect.map(
    makeCsvWriter({ dialect, quoting }).write(
      // a raw grid: each row a plain row of plain string cells
      trustAs(document([worksheetFromRows("Sheet1", grid)])),
    ),
    (content) =>
      Predicate.isTagged(content, "Text") ? content.text : new TextDecoder().decode(content.bytes),
  );

/** `csv` cut at `at` (fractions of its length) into stream chunks. */
const chunked = (csv: string, at: ReadonlyArray<number>): ReadonlyArray<string> => {
  const points = Arr.sort(Arr.dedupe(at.map((f) => Math.floor(f * csv.length))), Order.Number);
  return [0, ...points]
    .map((from, i) => csv.slice(from, points[i] ?? csv.length))
    .filter((c) => c !== "");
};

/** Whether two grids hold the same rows of the same fields. */
const sameGrid = Arr.makeEquivalence(Arr.makeEquivalence(Equivalence.String));

/** Ragged grids are allowed, and nothing is filtered. */
const SCAN = { allowVariableColumns: true } as const;

const CASES: ReadonlyArray<readonly [string, CsvDialect, CsvQuoting]> = [
  ["CSV, minimal quoting", StandardDialect, "minimal"],
  ["CSV, all quoted", StandardDialect, "all"],
  ["TSV, minimal quoting", TsvDialect, "minimal"],
];

describe("raw grids round-trip (#92)", () => {
  it.effect.each(CASES)(
    "%s: scanCsv(write(grid)) is grid, whole and streamed",
    ([_, dialect, quoting]) =>
      Effect.gen(function* () {
        const result = yield* Arbitrary.checkEffect(
          Arbitrary.all([grids, cuts]),
          ([grid, at]) =>
            Effect.gen(function* () {
              const csv = yield* written(grid, dialect, quoting);
              const whole = (yield* scanCsv(csv, dialect, SCAN)).rows;
              const streamed = yield* Stream.runCollect(
                scanCsvStream(Stream.fromIterable(chunked(csv, at)), dialect, SCAN),
              );
              return sameGrid(whole, grid) && sameGrid(streamed, grid);
            }),
          { runs: 300, seed: 92 },
        );
        assert.strictEqual(Arbitrary.formatCheckFailure(result), undefined);
      }),
  );
});
