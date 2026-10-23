/**
 * The PDF profile: the prose subset this package reads and writes - headings,
 * paragraphs, bullet/ordered lists, code blocks, block quotes and rules, with
 * bold/italic/underline/strikeout runs, inline code and links.
 *
 * Writing renders all of it. Reading recovers what survives on the page:
 * headings (by font size), paragraphs, lists, code blocks, bold, italic,
 * inline code and links; underlines, strikeouts, quotes and rules are only
 * drawn lines and come back as plain text (or not at all).
 */

import { defineProfile, type FeaturesOf } from "@thomasfosterau/effect-document";

/** The features the PDF profile allows, as a list. */
export const pdfFeatures = [
  "block.plain",
  "block.para",
  "block.header",
  "block.bulletList",
  "block.orderedList",
  "block.codeBlock",
  "block.blockQuote",
  "block.horizontalRule",
  "inline.str",
  "inline.space",
  "inline.softBreak",
  "inline.lineBreak",
  "inline.emph",
  "inline.strong",
  "inline.underline",
  "inline.strikeout",
  "inline.code",
  "inline.link",
] as const;

/** The PDF profile. */
export const Pdf = defineProfile("pdf", pdfFeatures);

/** The features the PDF profile allows, as a type: the phantom of its documents. */
export type PdfFeature = FeaturesOf<typeof Pdf>;

/**
 * What the PDF writer preserves through `read(write(doc))` (#109). Block
 * quotes, rules, line breaks, underline and strikeout aren't recovered by the
 * layout reader, so those are narrowed away (with a loss report) on write.
 * Neither is inline code: a monospace run that fills a line (or a wrapped
 * line's start) reads back as a code block (#198).
 */
export const PdfWrite = defineProfile("pdf-write", [
  "block.plain",
  "block.para",
  "block.header",
  "block.bulletList",
  "block.orderedList",
  "block.codeBlock",
  "inline.str",
  "inline.space",
  "inline.softBreak",
  "inline.emph",
  "inline.strong",
  "inline.link",
] as const);

/** The features of {@link PdfWrite}, what the PDF writer accepts, as a type. */
export type PdfWriteFeature = FeaturesOf<typeof PdfWrite>;
