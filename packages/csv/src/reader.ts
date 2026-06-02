/**
 * The CSV Reader: CSV text -> tabular Workbook.
 *
 * Implements the @effect-pandoc/core Reader interface, with optional type
 * inference (strings -> numbers / booleans / nulls) and row streaming.
 */

import { Effect, Layer, Stream, pipe } from "effect";
import {
  Sheet,
  Workbook,
  cell,
  contentToText,
  makeReaderTag,
  type Cell,
  type Content,
  type ParseError,
  type Reader,
} from "@effect-pandoc/core";
import { StandardDialect, type CsvDialect } from "./dialect.js";
import { scanCsv, type CsvScanOptions } from "./scanner.js";

export interface CsvReaderOptions extends CsvScanOptions {
  /** The CSV dialect to parse with (defaults to StandardDialect) */
  readonly dialect?: CsvDialect;
  /**
   * Infer cell types from string values: numbers, booleans ("true"/"false"),
   * and empty strings (-> null cells). Set to false to keep every value as a
   * string cell for lossless round-trips. Defaults to true.
   */
  readonly inferTypes?: boolean;
  /** Name of the produced sheet (defaults to "Sheet1") */
  readonly sheetName?: string;
}

/** Infer a typed cell from a raw CSV string value */
export const inferCell = (raw: string): Cell => {
  if (raw === "") {
    return cell.empty();
  }
  if (raw === "true") {
    return cell.bool(true);
  }
  if (raw === "false") {
    return cell.bool(false);
  }
  if (raw.trim() !== "") {
    const num = Number(raw);
    if (Number.isFinite(num)) {
      return cell.num(num);
    }
  }
  return cell.str(raw);
};

/**
 * Create a CSV Reader with the given options baked in.
 */
export const makeCsvReader = (options?: CsvReaderOptions): Reader => {
  const dialect = options?.dialect ?? StandardDialect;
  const inferTypes = options?.inferTypes ?? true;
  const sheetName = options?.sheetName ?? "Sheet1";
  const toCell: (raw: string) => Cell = inferTypes ? inferCell : cell.str;

  const readWorkbook = (input: Content): Effect.Effect<Workbook, ParseError> =>
    pipe(
      scanCsv(contentToText(input), dialect, options),
      Effect.map(
        ({ headers, rows }) =>
          new Workbook({
            sheets: [
              new Sheet({
                name: sheetName,
                headers,
                rows: rows.map((row) => row.map(toCell)),
              }),
            ],
          })
      )
    );

  const readRowStream = (
    input: Content
  ): Stream.Stream<ReadonlyArray<string>, ParseError> =>
    pipe(
      scanCsv(contentToText(input), dialect, options),
      Effect.map((table) => table.rows),
      Stream.fromIterableEffect
    );

  return {
    format: "csv",
    readWorkbook,
    readRowStream,
  };
};

/** Context tag for dependency-injection style usage */
export const CsvReaderTag = makeReaderTag("csv");

/** Layer providing a CSV Reader with default options */
export const CsvReaderLive = Layer.succeed(CsvReaderTag, makeCsvReader());

/** Layer providing a CSV Reader with custom options */
export const makeCsvReaderLayer = (options?: CsvReaderOptions) =>
  Layer.succeed(CsvReaderTag, makeCsvReader(options));
