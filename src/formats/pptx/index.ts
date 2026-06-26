/**
 * effect-document: pptx
 *
 * A native PowerPoint (.pptx / PresentationML) reader and writer for a
 * presentation subset: slides of text-box / placeholder shapes whose content is
 * paragraphs, headings and lists with bold/italic/underline/strike runs.
 */

import { type Format } from "../../io/format.js";
import { Pptx, type PptxFeature } from "./profile.js";
import { makePptxReader, type PptxReaderOptions } from "./reader.js";
import { makePptxWriter, type PptxWriterOptions } from "./writer.js";

export * from "./profile.js";
export * from "./reader.js";
export * from "./writer.js";

/** The PPTX profile. */
export const profile = Pptx;

export interface PptxFormatOptions {
  readonly reader?: PptxReaderOptions;
  readonly writer?: PptxWriterOptions;
}

/** Create a PPTX Format bundle with custom reader/writer options. */
export const makeFormat = (options?: PptxFormatOptions): Format<PptxFeature> => ({
  id: "pptx",
  profile: Pptx,
  reader: makePptxReader(options?.reader),
  writer: makePptxWriter(options?.writer),
});

/** The PPTX format bundle with default options, for use with `convert`. */
export const format: Format<PptxFeature> = makeFormat();
