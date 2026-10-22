/**
 * effect-document: docx
 *
 * A native Word (.docx / WordprocessingML) reader and writer covering a rich
 * prose subset: headings, paragraphs, runs (bold/italic/underline/strike/
 * super/sub/small-caps), hyperlinks, bullet/ordered lists and tables.
 */

import { type Format } from "@thomasfosterau/effect-document";
import { Docx, type DocxFeature } from "./profile.ts";
import { makeDocxReader, type DocxReaderOptions } from "./reader.ts";
import { makeDocxWriter, type DocxWriterOptions } from "./writer.ts";

export * from "./profile.ts";
export * from "./reader.ts";
export * from "./writer.ts";

/** The DOCX profile. */
export const profile = Docx;

/** Options for the DOCX format bundle: its reader's and writer's options. */
export interface DocxFormatOptions {
  readonly reader?: DocxReaderOptions | undefined;
  readonly writer?: DocxWriterOptions | undefined;
}

/** Create a DOCX Format bundle with custom reader/writer options. */
export const makeFormat = (options?: DocxFormatOptions): Format<DocxFeature> => ({
  id: "docx",
  readProfile: Docx,
  writeProfile: Docx,
  reader: makeDocxReader(options?.reader),
  writer: makeDocxWriter(options?.writer),
});

/** The DOCX format bundle with default options, for use with `convert`. */
export const format: Format<DocxFeature> = makeFormat();
