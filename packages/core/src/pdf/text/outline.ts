/**
 * The document outline (bookmarks, #20): each item's title and its depth in
 * the outline tree. The layout reader takes a heading's level from the outline
 * item with its title, when there is one, instead of ranking heading sizes.
 *
 * The walk follows `/First` and `/Next` with an explicit work list, visits at
 * most {@link MAX_ITEMS} items and stops at a reference it has seen, so a
 * damaged or cyclic outline ends rather than loops.
 */

import * as Arr from "effect/Array";
import * as MutableHashSet from "effect/MutableHashSet";
import * as Option from "effect/Option";
import type { PdfFile } from "../cos/file.ts";
import { type PdfDict, type PdfObject, isDict, isRef, isString } from "../cos/objects.ts";
import { decodeTextString } from "./encodings.ts";

/** An outline item: its title (whitespace collapsed) and its depth (1 for a top-level item). */
export interface OutlineItem {
  readonly title: string;
  readonly depth: number;
}

/** How many items the reader walks before it stops. */
const MAX_ITEMS = 100_000;

/** A title with its whitespace collapsed, for matching against a heading's text. */
export const outlineTitle = (text: string): string => text.replace(/\s+/g, " ").trim();

/** The document's outline items, in document order (empty when it has none). */
export const readOutline = (file: PdfFile): ReadonlyArray<OutlineItem> => {
  const root = file.lookupDict(file.catalog, "Outlines");
  const first = root?.entries.get("First");
  if (root === undefined || first === undefined) return [];
  const seen = MutableHashSet.empty<string>();
  /** The item a `/First` or `/Next` points at, unless it was seen already. */
  const item = (ref: PdfObject | undefined): PdfDict | undefined => {
    if (isRef(ref)) {
      const key = `${ref.num} ${ref.gen}`;
      if (MutableHashSet.has(seen, key)) return undefined;
      MutableHashSet.add(seen, key);
    }
    const d = file.resolve(ref);
    return isDict(d) ? d : undefined;
  };
  // the work list holds each next item to visit and its depth, in reverse document order
  const work: Array<readonly [PdfObject | undefined, number]> = [[first, 1]];
  return Arr.unfold(0, (count): Option.Option<readonly [ReadonlyArray<OutlineItem>, number]> => {
    const next = work.pop();
    if (next === undefined || count >= MAX_ITEMS) return Option.none();
    const [ref, depth] = next;
    const d = item(ref);
    if (d === undefined) return Option.some([[], count + 1] as const);
    // the next sibling comes after this item's children
    work.push([d.entries.get("Next"), depth], [d.entries.get("First"), depth + 1]);
    const title = file.resolve(d.entries.get("Title"));
    return Option.some([
      isString(title) ? [{ title: outlineTitle(decodeTextString(title.bytes)), depth }] : [],
      count + 1,
    ] as const);
  }).flat();
};
