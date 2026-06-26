/**
 * effect-document: csv
 *
 * CSV/TSV reader and writer: parse CSV text into a single-worksheet document in
 * the CSV profile, render such documents back to CSV, stream rows, and
 * synthesize test data.
 */

import { Csv } from "../../profile/profiles.js";
import { type Format } from "../../io/format.js";
import { makeCsvReader, type CsvFeature, type CsvReaderOptions } from "./reader.js";
import { makeCsvWriter, type CsvWriterOptions } from "./writer.js";
import { TsvDialect } from "./dialect.js";

export * from "./dialect.js";
export * from "./scanner.js";
export * from "./reader.js";
export * from "./writer.js";
export * from "./synthesize.js";

/** The CSV profile: a single worksheet of text/number/boolean/blank cells. */
export const profile = Csv;

export interface CsvFormatOptions {
  readonly reader?: CsvReaderOptions;
  readonly writer?: CsvWriterOptions;
}

/** Create a CSV Format bundle with custom reader/writer options. */
export const makeFormat = (options?: CsvFormatOptions): Format<CsvFeature> => ({
  id: "csv",
  profile: Csv,
  reader: makeCsvReader(options?.reader),
  writer: makeCsvWriter(options?.writer),
});

/**
 * The CSV format bundle with default options, for use with `convert`:
 *
 * ```ts
 * convert({ from: Csv.format, to: Xlsx.format, input: text("a,b\n1,2") })
 * ```
 */
export const format: Format<CsvFeature> = makeFormat();

/** The TSV (tab-separated values) format bundle. */
export const tsvFormat: Format<CsvFeature> = {
  id: "tsv",
  profile: Csv,
  reader: makeCsvReader({ dialect: TsvDialect }),
  writer: makeCsvWriter({ dialect: TsvDialect }),
};
