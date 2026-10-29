/**
 * The structure tree of a tagged PDF (#198, #19): the elements a generator
 * recorded (headings, paragraphs, lists, code, quotes, …) and the marked
 * content on each page that each one owns.
 *
 * Custom structure types are mapped to standard ones through the `/RoleMap`.
 * The walk is bounded (depth and element count) and guards against reference
 * cycles; a tree it can't read is treated as absent, so the reader falls back
 * to inferring structure from the layout.
 */

import * as Arr from "effect/Array";
import * as MutableHashSet from "effect/MutableHashSet";
import * as Predicate from "effect/Predicate";
import type { PdfFile } from "../cos/file.ts";
import {
  type PdfDict,
  type PdfObject,
  type PdfRef,
  isArray,
  isDict,
  isRef,
} from "../cos/objects.ts";

/** Marked content on a page: what a structure element owns of the page's glyphs. */
export interface MarkedContent {
  readonly _tag: "Content";
  /** The page's index in the document. */
  readonly page: number;
  readonly mcid: number;
}

/** A structure element: its standard type and its kids, in reading order. */
export interface StructElement {
  readonly _tag: "Element";
  /** The standard structure type (`P`, `H2`, `L`, …), after the role map. */
  readonly type: string;
  /** The type as the file names it, before the role map (a custom `Heading 1`, say). */
  readonly ownType: string;
  readonly kids: ReadonlyArray<StructElement | MarkedContent>;
  /** The list attribute `/ListNumbering` (`Decimal`, `Disc`, …), for an `L`. */
  readonly listNumbering?: string | undefined;
  /** The layout attribute `/Placement` (`Block`, `Inline`, …). */
  readonly placement?: string | undefined;
}

/** How deep the tree may nest before it is treated as unreadable. */
const MAX_DEPTH = 256;
/** How many elements the tree may have before it is treated as unreadable. */
const MAX_ELEMENTS = 1_000_000;

/** An attribute's value, from an element's `/A` (a dictionary, or an array of them and revision numbers). */
const attribute = (file: PdfFile, elem: PdfDict, key: string): string | undefined => {
  const a = file.resolve(elem.entries.get("A"));
  const dicts = isArray(a) ? a.items.map((x) => file.resolve(x)) : [a];
  return dicts.flatMap((d) => {
    const name = isDict(d) ? file.lookupName(d, key) : undefined;
    return name === undefined ? [] : [name];
  })[0];
};

/**
 * The document's structure tree, or `undefined` when it has none, or one
 * that is too deep, too large or not a tree. `pages` are the pages' object
 * references, in document order, to place each element's content.
 */
export const readStructure = (
  file: PdfFile,
  pages: ReadonlyArray<PdfRef | undefined>,
): StructElement | undefined => {
  const root = file.lookupDict(file.catalog, "StructTreeRoot");
  if (root === undefined) return undefined;
  const roleMap = file.lookupDict(root, "RoleMap");
  /** A type through the role map (a few steps, to a standard type or a dead end). */
  const role = (type: string): string =>
    // at most 8 steps, so a cycle in the map ends
    Arr.reduce(Arr.range(1, 8), type, (t) => file.lookupName(roleMap, t) ?? t);
  const pageOf = (ref: PdfObject | undefined): number | undefined => {
    if (!isRef(ref)) return undefined;
    const i = pages.findIndex((p) => p !== undefined && p.num === ref.num && p.gen === ref.gen);
    return i < 0 ? undefined : i;
  };

  const seen = MutableHashSet.empty<string>();
  let elements = 0;
  let broken = false;

  /** Whether `kid` is met for the first time; a reference met again is a cycle, which breaks the tree. */
  const firstVisit = (kid: PdfObject | undefined): boolean => {
    if (!isRef(kid)) return true;
    const key = `${kid.num} ${kid.gen}`;
    if (MutableHashSet.has(seen, key)) {
      broken = true;
      return false;
    }
    MutableHashSet.add(seen, key);
    return true;
  };

  /** A marked-content reference's content (none for content in a Form XObject's stream, `/Stm`). */
  const markedRef = (d: PdfDict, ownPage: number | undefined): MarkedContent[] => {
    const mcid = file.lookupNumber(d, "MCID");
    const p = pageOf(d.entries.get("Pg")) ?? ownPage;
    return mcid === undefined || p === undefined || d.entries.has("Stm")
      ? []
      : [{ _tag: "Content", page: p, mcid }];
  };

  /** One kid of an element on `ownPage`: content, a marked-content reference, or an element. */
  const kidOf = (
    kid: PdfObject | undefined,
    ownPage: number | undefined,
    depth: number,
  ): Array<StructElement | MarkedContent> => {
    if (Predicate.isNumber(kid))
      return ownPage === undefined ? [] : [{ _tag: "Content", page: ownPage, mcid: kid }];
    if (!firstVisit(kid)) return [];
    const d = file.resolve(kid);
    if (!isDict(d)) return [];
    const type = file.lookupName(d, "Type");
    if (type === "MCR") return markedRef(d, ownPage);
    // an annotation (OBJR) adds nothing: links are placed by their rectangles
    if (type === "OBJR" || file.lookupName(d, "S") === undefined) return [];
    const child = element(d, ownPage, depth + 1);
    return child === undefined ? [] : [child];
  };

  const element = (
    elem: PdfDict,
    page: number | undefined,
    depth: number,
  ): StructElement | undefined => {
    elements += 1;
    if (depth > MAX_DEPTH || elements > MAX_ELEMENTS) {
      broken = true;
      return undefined;
    }
    const ownPage = pageOf(elem.entries.get("Pg")) ?? page;
    const k = file.resolve(elem.entries.get("K"));
    const raw = isArray(k) ? k.items : k === undefined ? [] : [elem.entries.get("K")];
    const kids = raw.flatMap((kid) => (broken ? [] : kidOf(kid, ownPage, depth)));
    return {
      _tag: "Element",
      type: role(file.lookupName(elem, "S") ?? ""),
      ownType: file.lookupName(elem, "S") ?? "",
      kids,
      listNumbering: attribute(file, elem, "ListNumbering"),
      placement: attribute(file, elem, "Placement"),
    };
  };

  // the root's kids are the top-level elements; wrap them in one `Document`
  const k = file.resolve(root.entries.get("K"));
  const tops = (isArray(k) ? k.items : k === undefined ? [] : [root.entries.get("K")]).flatMap(
    (kid) => {
      const d = file.resolve(kid);
      if (!isDict(d) || file.lookupName(d, "S") === undefined) return [];
      const e = element(d, undefined, 1);
      return e === undefined ? [] : [e];
    },
  );
  if (broken) return undefined;
  return { _tag: "Element", type: "Document", ownType: "Document", kids: tops };
};
