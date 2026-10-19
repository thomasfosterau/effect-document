/**
 * effect-document: docx
 *
 * A native Word (.docx / WordprocessingML) reader and writer covering a rich
 * prose subset: headings, paragraphs, runs (bold/italic/underline/strike/
 * super/sub/small-caps), hyperlinks, bullet/ordered lists and tables.
 */

import { type Format } from "@thomasfosterau/effect-document";
import { Docx, type DocxFeature } from "./profile.js";
import { makeDocxReader, type DocxReaderOptions } from "./reader.js";
import { makeDocxWriter, type DocxWriterOptions } from "./writer.js";

export * from "./profile.js";
export * from "./reader.js";
export * from "./writer.js";

/** The DOCX profile. */
export const profile = Docx;

export interface DocxFormatOptions {
  readonly reader?: DocxReaderOptions;
  readonly writer?: DocxWriterOptions;
}

/** Create a DOCX Format bundle with custom reader/writer options. */
export const makeFormat = (options?: DocxFormatOptions): Format<DocxFeature> => ({
  id: "docx",
  profile: Docx,
  reader: makeDocxReader(options?.reader),
  writer: makeDocxWriter(options?.writer),
});

/** The DOCX format bundle with default options, for use with `convert`. */
export const format: Format<DocxFeature> = makeFormat();
