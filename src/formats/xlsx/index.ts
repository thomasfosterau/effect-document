/**
 * effect-document: xlsx
 *
 * Native Excel (.xlsx) reader and writer for effect-document. Implements the
 * OOXML SpreadsheetML format directly - the only third-party dependency is
 * fflate (for zip).
 *
 * Supported: multiple sheets, shared strings, inline strings, numbers,
 * booleans, dense cell grids.
 * Not yet supported: styles, formulas, date serial numbers (dates round-trip
 * as ISO-8601 strings).
 */

import type { Format } from "../../core/index.js";
import { makeXlsxReader, type XlsxReaderOptions } from "./reader.js";
import { makeXlsxWriter, type XlsxWriterOptions } from "./writer.js";

export * from "./a1.js";
export * from "./xml.js";
export * from "./cellTypes.js";
export * from "./reader.js";
export * from "./writer.js";

export interface XlsxFormatOptions {
  readonly reader?: XlsxReaderOptions;
  readonly writer?: XlsxWriterOptions;
}

/** Create an XLSX Format bundle with custom reader/writer options */
export const makeFormat = (options?: XlsxFormatOptions): Format => ({
  id: "xlsx",
  reader: makeXlsxReader(options?.reader),
  writer: makeXlsxWriter(options?.writer),
});

/**
 * The XLSX format bundle with default options, for use with `convert`:
 *
 * ```ts
 * import * as Xlsx from "@thomasfosterau/effect-document/xlsx"
 * convert({ from: ..., to: Xlsx.format, input: ... })
 * ```
 */
export const format: Format = makeFormat();
