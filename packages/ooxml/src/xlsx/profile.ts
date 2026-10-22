/**
 * The XLSX profiles. Following the profile policy (#109), the write profile
 * holds only what survives `read(write(doc))`; the read profile is what the
 * reader produces, which differs where the reader understands more than the
 * writer emits (ISO `t="d"` dates, non-grid sheets tagged `attr.data.kind`).
 *
 * Not (yet) preserved, so narrowed away on write with a loss report: column
 * widths, merges, row heights, cell styles, attributes, rich-text runs
 * (flattened) and dates (written as ISO text).
 */

import { defineProfile, type FeaturesOf } from "@thomasfosterau/effect-document";

export const xlsxFeatures = [
  "sheet.worksheet",
  "sheet.multiple",
  "cell.text",
  "cell.number",
  "cell.boolean",
  "cell.error",
  "cell.blank",
  "cell.formula",
] as const;

/** What the XLSX writer preserves. */
export const Xlsx = defineProfile("xlsx", xlsxFeatures);
export type XlsxFeature = FeaturesOf<typeof Xlsx>;

/** What the XLSX reader produces. */
export const XlsxRead = defineProfile("xlsx-read", [
  ...xlsxFeatures,
  "cell.date",
  "attr.keyValue",
] as const);
export type XlsxReadFeature = FeaturesOf<typeof XlsxRead>;
