/**
 * The one place a dictionary's entry map is created.
 *
 * `PdfDict.entries` is a native `Map` because it is part of the public object
 * model (callers read it with `.get`, iterate it in insertion order, and pass
 * their own `Map`s to `pdfDict`), so it can't become an Effect `HashMap`
 * without changing the package's API.
 */

import type { PdfObject } from "./objects.ts";

/** A new entry map for a `PdfDict`, optionally filled from key/value pairs. */
export const makeEntries = (
  entries: Iterable<readonly [string, PdfObject]> = [],
): Map<string, PdfObject> => new Map(entries);
