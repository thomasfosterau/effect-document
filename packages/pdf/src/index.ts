/**
 * effect-document: pdf
 *
 * A PDF reader and writer for a prose subset of the schema, built on a
 * dependency-light PDF object layer (`./cos`): parsing (with repair of damaged
 * files), stream filters, text extraction and layout analysis, and writing.
 */

import { type Format } from "@thomasfosterau/effect-document";
import { Pdf, type PdfFeature, PdfWrite, type PdfWriteFeature } from "./profile.js";
import { makePdfReader } from "./reader.js";
import { makePdfWriter } from "./writer.js";

export * from "./profile.js";
export * from "./reader.js";
export * from "./writer.js";
export { decodeTextString, glyphToUnicode } from "./text/encodings.js";
export { type PageLink, type PageText, type TextGlyph, extractPageText } from "./text/extract.js";
export { type Glyph, type PdfFont, loadFont } from "./text/font.js";
export { layoutBlocks } from "./text/layout.js";

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
