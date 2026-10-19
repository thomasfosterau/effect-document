/**
 * Built-in profiles spanning the three document families. They demonstrate the
 * subset mechanism - poorer formats allow fewer features and fewer attribute
 * facets - and serve as ready targets for `narrow`/`convert`.
 *
 * Formats define their own profiles the same way (see `defineProfile`); these
 * are just the common ones.
 */

import {
  ALL_ATTR_FEATURES, ALL_BLOCK_FEATURES, ALL_DECK_FEATURES, ALL_FEATURES,
  ALL_INLINE_FEATURES, ALL_SHEET_FEATURES,
} from "../schema/feature.js";
import { defineProfile } from "./profile.js";

// ---- spreadsheets ---------------------------------------------------------

/** CSV/TSV: a single worksheet of text/number/boolean/blank cells, no styling. */
export const csvFeatures = [
  "sheet.worksheet",
  "cell.text",
  "cell.number",
  "cell.boolean",
  "cell.blank",
] as const;
export const Csv = defineProfile("csv", csvFeatures);

/** A full spreadsheet (XLSX/ODS): multi-sheet, all cell types, styling, merges. */
export const Spreadsheet = defineProfile("spreadsheet", [
  ...ALL_SHEET_FEATURES,
  ...ALL_INLINE_FEATURES, // rich-text cell runs
  ...ALL_ATTR_FEATURES,
]);

// ---- prose documents ------------------------------------------------------

/** Markdown/Wikitext: common prose with ids & classes, no inline styling. */
export const Markdown = defineProfile("markdown", [
  "block.plain", "block.para", "block.header", "block.codeBlock",
  "block.blockQuote", "block.orderedList", "block.bulletList",
  "block.horizontalRule", "block.table", "block.div",
  "inline.str", "inline.space", "inline.softBreak", "inline.lineBreak",
  "inline.emph", "inline.strong", "inline.strikeout", "inline.code",
  "inline.link", "inline.image", "inline.quoted",
  "attr.id", "attr.classes",
]);

/** HTML/OOXML/ODF prose: the full prose vocabulary with rich attributes. */
export const Html = defineProfile("html", [
  ...ALL_BLOCK_FEATURES,
  ...ALL_INLINE_FEATURES,
  ...ALL_ATTR_FEATURES,
]);

// ---- presentations --------------------------------------------------------

/** Presentations (PPTX/Keynote): slides, shapes, notes, with prose inside. */
export const Presentation = defineProfile("presentation", [
  ...ALL_DECK_FEATURES,
  ...ALL_BLOCK_FEATURES,
  ...ALL_INLINE_FEATURES,
  ...ALL_ATTR_FEATURES,
]);

// ---- everything -----------------------------------------------------------

/** The maximal profile: every feature the schema can express. */
export const Full = defineProfile("full", ALL_FEATURES);
