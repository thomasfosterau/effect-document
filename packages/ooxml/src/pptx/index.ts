/**
 * effect-document: pptx
 *
 * A native PowerPoint (.pptx / PresentationML) reader and writer for a
 * presentation subset: slides of text-box / placeholder shapes whose content is
 * paragraphs, headings and lists with bold/italic/underline/strike runs.
 */

import { type Format } from "@thomasfosterau/effect-document";
import { Pptx, type PptxFeature, PptxRead, type PptxReadFeature } from "./profile.ts";
import { makePptxReader, type PptxReaderOptions } from "./reader.ts";
import { makePptxWriter, type PptxWriterOptions } from "./writer.ts";

export * from "./profile.ts";
export * from "./reader.ts";
export * from "./writer.ts";

/** The PPTX profile. */
export const profile = Pptx;

/** Options for the PPTX format bundle: its reader's and writer's options. */
export interface PptxFormatOptions {
  readonly reader?: PptxReaderOptions | undefined;
  readonly writer?: PptxWriterOptions | undefined;
}

/** Create a PPTX Format bundle with custom reader/writer options. */
export const makeFormat = (options?: PptxFormatOptions): Format<PptxReadFeature, PptxFeature> => ({
  id: "pptx",
  readProfile: PptxRead,
  writeProfile: Pptx,
  reader: makePptxReader(options?.reader),
  writer: makePptxWriter(options?.writer),
});

/** The PPTX format bundle with default options, for use with `convert`. */
export const format: Format<PptxReadFeature, PptxFeature> = makeFormat();
