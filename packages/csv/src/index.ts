/**
 * @effect-pandoc/csv
 *
 * CSV/TSV reader and writer for effect-pandoc: parse CSV text into a typed
 * tabular Workbook, render Workbooks back to CSV, stream rows, and
 * synthesize test data.
 *
 * The legacy effect-csv v0.1.x API lives at "@effect-pandoc/csv/legacy".
 */

import type { Format } from "@effect-pandoc/core";
import { TsvDialect } from "./dialect.js";
import { makeCsvReader, type CsvReaderOptions } from "./reader.js";
import { makeCsvWriter, type CsvWriterOptions } from "./writer.js";

export * from "./dialect.js";
export * from "./scanner.js";
export * from "./reader.js";
export * from "./writer.js";
export * from "./synthesize.js";

export interface CsvFormatOptions {
  readonly reader?: CsvReaderOptions;
  readonly writer?: CsvWriterOptions;
}

/** Create a CSV Format bundle with custom reader/writer options */
export const makeFormat = (options?: CsvFormatOptions): Format => ({
  id: "csv",
  reader: makeCsvReader(options?.reader),
  writer: makeCsvWriter(options?.writer),
});

/**
 * The CSV format bundle with default options, for use with `convert`:
 *
 * ```ts
 * import * as Csv from "@effect-pandoc/csv"
 * convert({ from: Csv.format, to: ..., input: text("a,b\n1,2") })
 * ```
 */
export const format: Format = makeFormat();

/** The TSV (tab-separated values) format bundle with default options */
export const tsvFormat: Format = {
  id: "tsv",
  reader: makeCsvReader({ dialect: TsvDialect }),
  writer: makeCsvWriter({ dialect: TsvDialect }),
};
