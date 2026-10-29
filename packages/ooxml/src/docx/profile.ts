/**
 * The DOCX profile: a rich prose subset of the schema - headings, paragraphs,
 * ordered/bullet lists and tables, with the common inline formatting plus
 * links, plus code blocks (a `Code`-styled paragraph). (No spreadsheets or
 * slides.)
 *
 * Following the profile policy (#109), it holds only what survives
 * `read(write(doc))`. The writer also renders block quotes, divs and line
 * blocks (flattened), rules, inline code and quotations (as marks), but
 * they don't read back as such, so converting to DOCX narrows them with a
 * loss report until they round-trip.
 */

import { defineProfile, type FeaturesOf } from "@thomasfosterau/effect-document";

/** The features the DOCX profile allows, as a list. */
export const docxFeatures = [
  "block.plain",
  "block.para",
  "block.header",
  "block.bulletList",
  "block.orderedList",
  "block.codeBlock",
  "block.table",
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
  "inline.link",
  // a heading's id, kept as a bookmark around it, and any other bookmarked
  // text as a span with an id (#184); ids elsewhere are not kept
  "inline.span",
  "attr.id.header",
  "attr.id.span",
] as const;

/** The DOCX (WordprocessingML) profile. */
export const Docx = defineProfile("docx", docxFeatures);

/** The features the DOCX profile allows, as a type: the phantom of its documents. */
export type DocxFeature = FeaturesOf<typeof Docx>;
