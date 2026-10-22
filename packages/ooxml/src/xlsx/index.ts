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
import { Xlsx, type XlsxFeature, XlsxRead, type XlsxReadFeature } from "./profile.ts";
import { makeXlsxReader, type XlsxReaderOptions } from "./reader.ts";
import { makeXlsxWriter, type XlsxWriterOptions } from "./writer.ts";

export * from "./a1.ts";
export * from "./xml.ts";
export * from "./cellTypes.ts";
export * from "./profile.ts";
export * from "./reader.ts";
export * from "./writer.ts";

/** The XLSX (write) profile: what survives a write -> read round trip. */
export const profile = Xlsx;

/** Options for the XLSX format bundle: its reader's and writer's options. */
export interface XlsxFormatOptions {
  readonly reader?: XlsxReaderOptions | undefined;
  readonly writer?: XlsxWriterOptions | undefined;
}

/** Create an XLSX Format bundle with custom reader/writer options. */
export const makeFormat = (options?: XlsxFormatOptions): Format<XlsxReadFeature, XlsxFeature> => ({
  id: "xlsx",
  readProfile: XlsxRead,
  writeProfile: Xlsx,
  reader: makeXlsxReader(options?.reader),
  writer: makeXlsxWriter(options?.writer),
});

/** The XLSX format bundle with default options, for use with `convert`. */
export const format: Format<XlsxReadFeature, XlsxFeature> = makeFormat();
