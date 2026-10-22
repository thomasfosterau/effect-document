/**
 * effect-document: pdf
 *
 * A PDF reader and writer for a prose subset of the schema, built on a
 * dependency-light PDF object layer (`./cos`): parsing (with repair of damaged
 * files), stream filters, text extraction and layout analysis, and writing.
 */

import { type Format } from "@thomasfosterau/effect-document";
import { Pdf, type PdfFeature, PdfWrite, type PdfWriteFeature } from "./profile.ts";
import { makePdfReader } from "./reader.ts";
import { makePdfWriter } from "./writer.ts";

export * from "./profile.ts";
export * from "./reader.ts";
export * from "./ocr.ts";
export * from "./writer.ts";
export { decodeTextString, glyphToUnicode } from "./text/encodings.ts";
export {
  type PageImage,
  type PageLink,
  type PageText,
  type TextGlyph,
  extractPageText,
} from "./text/extract.ts";
export { type Glyph, type PdfFont, loadFont } from "./text/font.ts";
export { layoutBlocks } from "./text/layout.ts";

/** The PDF profile. */
export const profile = Pdf;

/** The PDF format bundle, for use with `convert`. */
export const format: Format<PdfFeature, PdfWriteFeature> = {
  id: "pdf",
  readProfile: Pdf,
  writeProfile: PdfWrite,
  reader: makePdfReader(),
  // The writer renders the whole PDF profile; the format only promises what
  // reads back, so `convert` narrows to that.
  writer: { format: "pdf", profile: PdfWrite, write: makePdfWriter().write },
};
