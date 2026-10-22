/**
 * effect-document: csv
 *
 * CSV/TSV reader and writer: parse CSV text into a single-worksheet document in
 * the CSV profile, render such documents back to CSV, stream rows, and
 * synthesize test data.
 */

import { type Format } from "@thomasfosterau/effect-document";
import { Csv } from "@thomasfosterau/effect-document/profiles";
import { makeCsvReader, type CsvFeature, type CsvReaderOptions } from "./reader.ts";
import { makeCsvWriter, type CsvWriterOptions } from "./writer.ts";
import { TsvDialect } from "./dialect.ts";

export * from "./dialect.ts";
export * from "./scanner.ts";
export * from "./reader.ts";
export * from "./writer.ts";
export * from "./synthesize.ts";

/** The CSV profile: a single worksheet of text/number/boolean/blank cells. */
export const profile = Csv;

export interface CsvFormatOptions {
  readonly reader?: CsvReaderOptions | undefined;
  readonly writer?: CsvWriterOptions | undefined;
}

/** Create a CSV Format bundle with custom reader/writer options. */
export const makeFormat = (options?: CsvFormatOptions): Format<CsvFeature> => ({
  id: "csv",
  readProfile: Csv,
  writeProfile: Csv,
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
  readProfile: Csv,
  writeProfile: Csv,
  reader: makeCsvReader({ dialect: TsvDialect }),
  writer: makeCsvWriter({ dialect: TsvDialect }),
};
