/**
 * The DOCX profile: a rich prose subset of the schema - headings, paragraphs,
 * block quotes, ordered/bullet lists, code blocks, tables and horizontal rules,
 * with the common inline formatting plus links. (No spreadsheets or slides.)
 */

import { defineProfile, type FeaturesOf } from "@thomasfosterau/effect-document";

export const docxFeatures = [
  "block.plain",
  "block.para",
  "block.header",
  "block.blockQuote",
  "block.bulletList",
  "block.orderedList",
  "block.codeBlock",
  "block.table",
  "block.horizontalRule",
  "block.div",
  "block.lineBlock",
  "inline.str",
  "inline.space",
  "inline.softBreak",
  "inline.lineBreak",
  "inline.emph",
  "inline.strong",
  "inline.underline",
  "inline.strikeout",
  "inline.superscript",
  "inline.subscript",
  "inline.smallCaps",
  "inline.code",
  "inline.link",
  "inline.quoted",
] as const;

/** The DOCX (WordprocessingML) profile. */
export const Docx = defineProfile("docx", docxFeatures);

export type DocxFeature = FeaturesOf<typeof Docx>;
