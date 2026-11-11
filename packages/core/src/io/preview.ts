/**
 * Preview reads (#188): a reader given `maxRows` reads only the first rows
 * of a table, so a UI can show a large file without parsing all of it. A
 * truncated document says so in its metadata, under {@link TRUNCATED_META_KEY},
 * so it never passes for the whole file.
 */

import * as Predicate from "effect/Predicate";
import type { Feature } from "../schema/feature.ts";
import { Document } from "../schema/document.ts";
import { type Doc, trustAs } from "../profile/profile.ts";

/** The metadata key a truncated preview read sets. */
export const TRUNCATED_META_KEY = "truncated";

/** What a truncated preview read left out: the row limit it read to, and the worksheets it cut. */
export interface Truncation {
  /** The `maxRows` the read was given. */
  readonly maxRows: number;
  /** The worksheets that had more rows than that. */
  readonly sheets: ReadonlyArray<string>;
}

/** `doc` marked as a truncated preview (`meta.truncated`), keeping its profile. */
export const markTruncated = <F extends Feature>(doc: Doc<F>, truncation: Truncation): Doc<F> =>
  trustAs<F>(
    new Document({ meta: { ...doc.meta, [TRUNCATED_META_KEY]: truncation }, blocks: doc.blocks }),
  );

/** The truncation a preview read recorded on `doc`, if it left anything out. */
export const truncationOf = (doc: Document): Truncation | undefined => {
  const value: unknown = doc.meta[TRUNCATED_META_KEY];
  return Predicate.hasProperty(value, "maxRows") &&
    Predicate.isNumber(value.maxRows) &&
    Predicate.hasProperty(value, "sheets") &&
    Array.isArray(value.sheets)
    ? { maxRows: value.maxRows, sheets: value.sheets.filter(Predicate.isString) }
    : undefined;
};

/** Whether `doc` is a truncated preview rather than the whole file. */
export const isTruncated = (doc: Document): boolean => truncationOf(doc) !== undefined;
