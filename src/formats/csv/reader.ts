/**
 * The CSV Reader: CSV text -> a single-worksheet document in the CSV profile.
 *
 * Optional type inference turns raw strings into number/boolean/blank cells;
 * with inference off, every value stays a text cell for lossless round-trips.
 */

import { Effect, Layer, Stream, pipe } from "effect";
import { type Doc, type FeaturesOf, trustAs } from "../../profile/profile.js";
import { Csv } from "../../profile/profiles.js";
import {
  type SheetCell, SheetRow, Worksheet, cell, document,
} from "../../schema/index.js";
import { contentToText, type Content } from "../../io/content.js";
import { type ParseError } from "../../io/errors.js";
import { makeReaderTag, type Reader } from "../../io/reader.js";
import { StandardDialect, type CsvDialect } from "./dialect.js";
import { scanCsv, type CsvScanOptions } from "./scanner.js";

export type CsvFeature = FeaturesOf<typeof Csv>;

export interface CsvReaderOptions extends CsvScanOptions {
  /** The CSV dialect to parse with (defaults to StandardDialect). */
  readonly dialect?: CsvDialect;
  /**
   * Infer cell types from string values: numbers, booleans ("true"/"false"),
   * and empty strings (-> blank cells). Set to false to keep every value as a
   * text cell for lossless round-trips. Defaults to true.
   */
  readonly inferTypes?: boolean;
  /** Name of the produced worksheet (defaults to "Sheet1"). */
  readonly sheetName?: string;
}

/** Infer a typed cell from a raw CSV string value. */
export const inferCell = (raw: string): SheetCell => {
  if (raw === "") return cell.blank();
  if (raw === "true") return cell.boolean(true);
  if (raw === "false") return cell.boolean(false);
  if (raw.trim() !== "") {
    const num = Number(raw);
    if (Number.isFinite(num)) return cell.number(num);
  }
  return cell.text(raw);
};

/** Create a CSV Reader with the given options baked in. */
export const makeCsvReader = (options?: CsvReaderOptions): Reader<CsvFeature> => {
  const dialect = options?.dialect ?? StandardDialect;
  const inferTypes = options?.inferTypes ?? true;
  const sheetName = options?.sheetName ?? "Sheet1";
  const toCell: (raw: string) => SheetCell = inferTypes ? inferCell : cell.text;

  const read = (input: Content): Effect.Effect<Doc<CsvFeature>, ParseError> =>
    pipe(
      scanCsv(contentToText(input), dialect, options),
      Effect.map(({ headers, rows }) => {
        const grid: SheetCell[][] = [];
        if (headers !== null) grid.push(headers.map((h) => cell.text(h)));
        for (const row of rows) grid.push(row.map(toCell));
        const ws = new Worksheet({
          name: sheetName,
          columns: [],
          rows: grid.map((cells) => new SheetRow({ cells })),
          merges: [],
        });
        return trustAs<CsvFeature>(document([ws]));
      })
    );

  const readStream = (
    input: Content
  ): Stream.Stream<ReadonlyArray<string>, ParseError> =>
    pipe(
      scanCsv(contentToText(input), dialect, options),
      Effect.map((table) => table.rows),
      Stream.fromIterableEffect
    );

  return { format: "csv", profile: Csv, read, readStream };
};

/** Context tag for dependency-injection style usage. */
export const CsvReaderTag = makeReaderTag<CsvFeature>("csv");

/** Layer providing a CSV Reader with default options. */
export const CsvReaderLive = Layer.succeed(CsvReaderTag, makeCsvReader());

/** Layer providing a CSV Reader with custom options. */
export const makeCsvReaderLayer = (options?: CsvReaderOptions) =>
  Layer.succeed(CsvReaderTag, makeCsvReader(options));
