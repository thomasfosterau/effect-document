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

export type PdfFeature = FeaturesOf<typeof Pdf>;
