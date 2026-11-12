/**
 * The XLSX profiles. Following the profile policy (#109), the write profile
 * holds only what survives `read(write(doc))`; the read profile is what the
 * reader produces, which differs where the reader understands more than the
 * writer emits (ISO `t="d"` dates, non-grid sheets tagged `attr.data.kind`).
 *
 * Column widths (`<cols>`), merged ranges (`<mergeCells>`), custom row
 * heights (`<row ht customHeight="1">`), hidden rows, columns and worksheets
 * (`hidden="1"`, `<sheet state>`) and rich shared strings (bold,
 * italic, underline, strikethrough and superscript / subscript runs)
 * round-trip (#66), and so do cell comments (#67): legacy notes
 * (`xl/commentsN.xml` with the VML drawing Excel shows them with), whose body
 * is paragraphs, and so do threaded comments (replies, a resolved mark, a
 * date), whose text is plain (see `xlsxRules`). Not (yet) preserved, so narrowed away on write with a
 * loss report: per-column styles, cell styles, attributes, run fonts, sizes
 * and colours, and dates (written as ISO text).
 */

import { defineProfile, type FeaturesOf, type ProfileOptions } from "../../index.ts";

/** The features the XLSX profile allows, as a list. */
export const xlsxFeatures = [
  "sheet.worksheet",
  "sheet.multiple",
  "sheet.merges",
  "sheet.columns",
  // hidden rows, columns and worksheets (#66): `hidden="1"` and `<sheet state>`
  "sheet.hidden",
  "cell.text",
  "cell.number",
  "cell.boolean",
  "cell.error",
  "cell.blank",
  "cell.formula",
  // a rich shared string (#66): runs of text under bold, italic, underline,
  // strikethrough and superscript / subscript marks
  "cell.richText",
  "inline.str",
  "inline.space",
  "inline.softBreak",
  "inline.strong",
  "inline.emph",
  "inline.underline",
  "inline.strikeout",
  "inline.superscript",
  "inline.subscript",
  // a hyperlink (#67): over a whole cell, as the worksheet's <hyperlinks> holds it
  "inline.link",
  // a cell comment (#67): a legacy note, whose body is paragraphs (`block.para`,
  // allowed only inside a comment: see `xlsxRules`), or a thread of Excel's
  // threaded comments, whose text is plain
  "review.comments",
  "review.threads",
  "block.para",
] as const;

/** The inlines a threaded comment's plain text can't carry. */
const threadPlainFeatures = [
  "inline.strong",
  "inline.emph",
  "inline.underline",
  "inline.strikeout",
  "inline.superscript",
  "inline.subscript",
] as const;

/**
 * The structural rules both XLSX profiles keep (#67): paragraphs only inside
 * a cell comment, and, as SpreadsheetML links a whole cell
 * (`<hyperlink ref>`), a `Link` in a rich cell is its only run.
 */
const xlsxRules: ProfileOptions = {
  notWithin: [
    {
      feature: "inline.link",
      within: "review.comments",
      reason: "a SpreadsheetML comment holds text, not links",
    },
    {
      feature: "inline.softBreak",
      within: "review.comments",
      reason: "a line break in a SpreadsheetML comment starts a new paragraph",
    },
    // a threaded comment (a thread's root and replies) is plain text, a line per
    // paragraph, so it keeps none of the marks a legacy note's rich runs do
    ...threadPlainFeatures.map((feature) => ({
      feature,
      within: "review.threads" as const,
      reason: "a threaded comment is plain text",
    })),
  ],
  onlyWithin: [
    {
      feature: "block.para",
      within: "review.comments",
      reason: "a workbook holds paragraphs only in a cell comment",
    },
  ],
  whole: [
    {
      feature: "inline.link",
      within: "cell.richText",
      reason: "SpreadsheetML links a whole cell, not part of its text",
    },
  ],
};

/** What the XLSX writer preserves. */
export const Xlsx = defineProfile("xlsx", xlsxFeatures, xlsxRules);
/** The features the XLSX profile allows, as a type: the phantom of its documents. */
export type XlsxFeature = FeaturesOf<typeof Xlsx>;

/** What the XLSX reader produces. */
export const XlsxRead = defineProfile(
  "xlsx-read",
  [...xlsxFeatures, "cell.date", "attr.keyValue"] as const,
  xlsxRules,
);
/** The features of {@link XlsxRead}, what the XLSX reader produces, as a type. */
export type XlsxReadFeature = FeaturesOf<typeof XlsxRead>;
