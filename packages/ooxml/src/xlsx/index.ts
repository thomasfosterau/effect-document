/**
 * effect-document: xlsx
 *
 * Native Excel (.xlsx) reader and writer. Implements OOXML SpreadsheetML
 * directly - the only third-party dependency is fflate (for zip).
 *
 * Supported: multiple sheets, shared strings, inline strings, numbers, booleans,
 * errors, dense cell grids. Not yet: styles, real date serials (dates round-trip
 * as ISO-8601 strings), formula evaluation.
 */

import { type Format } from "@thomasfosterau/effect-document";
import { Spreadsheet } from "@thomasfosterau/effect-document/profiles";
import { makeXlsxReader, type SpreadsheetFeature, type XlsxReaderOptions } from "./reader.js";
import { makeXlsxWriter, type XlsxWriterOptions } from "./writer.js";

export * from "./a1.js";
export * from "./xml.js";
export * from "./cellTypes.js";
export * from "./reader.js";
export * from "./writer.js";

/** The Spreadsheet profile: multi-sheet, all cell types, styling, merges. */
export const profile = Spreadsheet;

export interface XlsxFormatOptions {
  readonly reader?: XlsxReaderOptions;
  readonly writer?: XlsxWriterOptions;
}

/** Create an XLSX Format bundle with custom reader/writer options. */
export const makeFormat = (options?: XlsxFormatOptions): Format<SpreadsheetFeature> => ({
  id: "xlsx",
  profile: Spreadsheet,
  reader: makeXlsxReader(options?.reader),
  writer: makeXlsxWriter(options?.writer),
});

/** The XLSX format bundle with default options, for use with `convert`. */
export const format: Format<SpreadsheetFeature> = makeFormat();
