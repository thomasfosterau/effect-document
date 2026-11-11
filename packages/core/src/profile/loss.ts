/**
 * The loss report (#112): what `narrow` and `convert` dropped or
 * down-converted, where, and how badly, as `Schema`s so a report encodes to
 * JSON. Its own module so the error types (`ConversionError` carries a
 * report) need nothing of `narrow`.
 */

import * as Arr from "effect/Array";
import * as Schema from "effect/Schema";
import { ALL_FEATURES, type Feature } from "../schema/feature.ts";

/**
 * One step of a {@link LossEntry}'s path: a number is a child's index (a
 * block among its siblings, an inline in its paragraph, a list item, a slide,
 * a shape, a table row or cell), a string names a part (`"notes"`, `"head"`,
 * `"body"`, `"foot"`, `"caption"`) or a worksheet cell by its A1 address.
 */
export const LossPathSegment = Schema.Union([Schema.Int, Schema.String]);
/** One step of a {@link LossEntry}'s path, as a type. */
export type LossPathSegment = typeof LossPathSegment.Type;

/**
 * How bad a loss is (#112), so a caller can act on what matters to it:
 * `dropped-content` (content is gone: a note, a picture, a sheet),
 * `dropped-formatting` (no text is gone, only how it looked or was
 * arranged: attributes, cell styles, column widths, merges, a horizontal
 * rule) or `converted` (the content is kept in a simpler form: a heading as
 * a paragraph, a date cell as text).
 */
export const LossSeverity = Schema.Literals(["dropped-content", "dropped-formatting", "converted"]);
/** How bad a loss is, as a type. */
export type LossSeverity = typeof LossSeverity.Type;

/**
 * One thing `narrow` could not keep: the feature, whether it was dropped or
 * converted, how bad that is, where it was, and why. A plain object with a
 * `Schema`, so a report encodes to JSON (for logs and CLI output) and an
 * entry costs no class instance (a narrowing can record one per cell).
 */
export const LossEntry = Schema.Struct({
  /** The feature that could not be represented. */
  feature: Schema.Literals(ALL_FEATURES),
  /** What happened: dropped, or down-converted to something simpler. */
  action: Schema.Literals(["dropped", "converted"]),
  /** How bad it is: see {@link LossSeverity}. */
  severity: LossSeverity,
  /** Where it was: the path from the document's blocks (see {@link LossPathSegment}); empty for the document as a whole. */
  path: Schema.Array(LossPathSegment),
  /** A short human-readable explanation. */
  detail: Schema.String,
});
/** One thing `narrow` could not keep, as a type. */
export type LossEntry = typeof LossEntry.Type;

/** How many times a feature was lost the same way, and where the first few were (#112). */
export const LossSummaryItem = Schema.Struct({
  feature: Schema.Literals(ALL_FEATURES),
  action: Schema.Literals(["dropped", "converted"]),
  severity: LossSeverity,
  /** How many entries this item stands for. */
  count: Schema.Int,
  /** The paths of the first {@link LOSS_SUMMARY_PATHS} of them, in document order. */
  paths: Schema.Array(Schema.Array(LossPathSegment)),
});
/** How many times a feature was lost the same way, as a type. */
export type LossSummaryItem = typeof LossSummaryItem.Type;

/** How many paths a {@link LossSummaryItem} keeps. */
export const LOSS_SUMMARY_PATHS = 5;

/** Everything a narrowing (or a conversion) dropped or down-converted, with a `Schema` for JSON. */
export const LossReport = Schema.Struct({
  /** Every loss, in document order. */
  entries: Schema.Array(LossEntry),
  /** The entries grouped by feature and action, in order of first appearance: 10,000 date cells are one item. */
  summary: Schema.Array(LossSummaryItem),
  /** True when nothing was lost (the narrowing was a no-op). */
  isLossless: Schema.Boolean,
});
/** Everything a narrowing (or a conversion) dropped or down-converted, as a type. */
export type LossReport = typeof LossReport.Type;

/** Features whose drop loses no text, only formatting or arrangement (`dropped-formatting`). */
const FORMATTING_DROPS: ReadonlyArray<Feature> = [
  "cell.style",
  "sheet.columns",
  "sheet.merges",
  "block.horizontalRule",
];

/** The severity of losing `feature` by `action` (see {@link LossSeverity}). */
export const severityOf = (feature: Feature, action: LossEntry["action"]): LossSeverity =>
  action === "converted"
    ? "converted"
    : feature.startsWith("attr.") || FORMATTING_DROPS.includes(feature)
      ? "dropped-formatting"
      : "dropped-content";

/** The report for `entries`: their summary, and whether there are none. */
export const lossReport = (entries: ReadonlyArray<LossEntry>): LossReport => {
  const items: Array<{ -readonly [K in keyof LossSummaryItem]: LossSummaryItem[K] }> = [];
  entries.forEach((e) => {
    // a summary holds one item per lost feature and action, so a scan is short
    const item = items.find((it) => it.feature === e.feature && it.action === e.action);
    if (item === undefined) {
      items.push({
        feature: e.feature,
        action: e.action,
        severity: e.severity,
        count: 1,
        paths: [e.path],
      });
    } else {
      item.count += 1;
      if (item.paths.length < LOSS_SUMMARY_PATHS) item.paths = [...item.paths, e.path];
    }
  });
  return { entries, summary: items, isLossless: Arr.isReadonlyArrayEmpty(entries) };
};
