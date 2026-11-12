/**
 * Cell hyperlinks (#67): a worksheet's `<hyperlinks>` read as a `Link` around
 * a text cell's content (the cell becoming a `CellRichText` of it), and a
 * `CellRichText` holding a `Link` written back as one. SpreadsheetML links a
 * whole cell, not a run of its text: a link to a URL is a relationship of the
 * worksheet's part (`r:id`, `TargetMode="External"`), one inside the workbook
 * is a `location` (`Sheet2!A1`), written and read as a `#`-prefixed URL.
 */

import * as Arr from "effect/Array";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import {
  cellOf,
  CellRichText,
  type Diagnostic,
  type Inline,
  isPlainRow,
  Link,
  rowCellsOf,
  type RowCell,
  type SheetCell,
  SheetRow,
  type Target,
  type WorksheetRow,
} from "../../index.ts";
import { parseA1Range, toA1 } from "./a1.ts";
import { inlinesOfText } from "./richText.ts";
import { findChild, findChildren, getAttr, type XmlElement } from "./xml.ts";

/** The relationship type of a hyperlink a worksheet's part points to. */
export const REL_HYPERLINK =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink";

/** A worksheet relationship, as the reader needs it: its id, target and whether it is external. */
interface SheetRelationship {
  readonly id: string;
  readonly type: string;
  readonly target: string;
  readonly external: boolean;
}

/** A hyperlink over a range of cells, 0-based and inclusive. */
interface CellRangeLink {
  readonly fromRow: number;
  readonly fromCol: number;
  readonly toRow: number;
  readonly toCol: number;
  readonly target: Target;
}

/** A hyperlink's URL: its relationship's target, its `location` after a `#`, or both. */
const urlOf = (el: XmlElement, rels: ReadonlyArray<SheetRelationship>): Option.Option<string> => {
  const id = getAttr(el, "id");
  const location = getAttr(el, "location");
  const rel = rels.find((r) => r.id === id && r.type === REL_HYPERLINK);
  const fragment = location === undefined || location === "" ? "" : `#${location}`;
  return rel === undefined
    ? fragment === ""
      ? Option.none()
      : Option.some(fragment)
    : Option.some(rel.target + fragment);
};

/**
 * A worksheet's hyperlinks, from its part's `root` and the part's
 * relationships, in the order `<hyperlinks>` lists them. One whose `ref` is
 * not an A1 range, or that points nowhere (no relationship and no
 * `location`), is left out.
 */
export const readHyperlinks = (
  root: XmlElement,
  rels: ReadonlyArray<SheetRelationship>,
): ReadonlyArray<CellRangeLink> => {
  const hyperlinks = findChild(root, "hyperlinks");
  return (hyperlinks === undefined ? [] : findChildren(hyperlinks, "hyperlink")).flatMap((el) => {
    const range = parseA1Range(getAttr(el, "ref") ?? "");
    const url = urlOf(el, rels);
    if (range === null || Option.isNone(url)) return [];
    const tooltip = getAttr(el, "tooltip");
    return [
      {
        fromRow: Math.min(range.start.row, range.end.row),
        fromCol: Math.min(range.start.col, range.end.col),
        toRow: Math.max(range.start.row, range.end.row),
        toCol: Math.max(range.start.col, range.end.col),
        target: tooltip === undefined ? { url: url.value } : { url: url.value, title: tooltip },
      },
    ];
  });
};

/** A cell with the link around its content: a text cell's or a rich cell's; any other kind can't hold one. */
const linkedCell = (cell: SheetCell, target: Target): Option.Option<SheetCell> =>
  Match.value(cell).pipe(
    Match.tag("CellText", (c) =>
      Option.some(
        new CellRichText({
          runs: [new Link({ content: inlinesOfText(c.value), target })],
          style: c.style,
        }),
      ),
    ),
    Match.tag("CellRichText", (c) =>
      Option.some(
        new CellRichText({ runs: [new Link({ content: c.runs, target })], style: c.style }),
      ),
    ),
    Match.orElse(() => Option.none()),
  );

/** The link over a cell, the last one listed winning (as Excel shows it). */
const linkAt = (
  links: ReadonlyArray<CellRangeLink>,
  row: number,
  col: number,
): Option.Option<Target> =>
  Option.map(
    Arr.findLast(
      links,
      (l) => row >= l.fromRow && row <= l.toRow && col >= l.fromCol && col <= l.toCol,
    ),
    (l) => l.target,
  );

/** {@link withHyperlinks}'s result: the rows, and the cells a link could not be kept on (A1 addresses). */
export interface LinkedRows {
  readonly rows: ReadonlyArray<WorksheetRow>;
  readonly unlinked: ReadonlyArray<string>;
}

/**
 * `rows` with `links` set on the cells they cover (a plain row's index being
 * one past the row before it):
 * a text or rich cell under a link becomes a `CellRichText` whose one run is
 * the `Link`. A number, boolean, error, formula or blank cell has nowhere to
 * hold a link, so it keeps its value and its address is listed in `unlinked`
 * for the reader to report. Rows without a linked cell are returned as they
 * are, a plain row staying plain.
 */
export const withHyperlinks = (
  rows: ReadonlyArray<WorksheetRow>,
  links: ReadonlyArray<CellRangeLink>,
): LinkedRows => {
  if (Arr.isReadonlyArrayEmpty(links)) return { rows, unlinked: [] };
  const unlinked: Array<string> = [];
  let previous = -1;
  const out = rows.map((row): WorksheetRow => {
    const index = isPlainRow(row) ? previous + 1 : row.index;
    previous = index;
    const cells = rowCellsOf(row);
    const linked = cells.map((position, col): RowCell => {
      const cell = cellOf(position);
      const target = linkAt(links, index, col);
      if (cell === undefined || Option.isNone(target)) return position;
      return Option.getOrElse(linkedCell(cell, target.value), () => {
        unlinked.push(toA1(col, index));
        return position;
      });
    });
    if (linked.every((c, col) => c === cells[col])) return row;
    return isPlainRow(row)
      ? linked
      : new SheetRow({ index: row.index, cells: linked, height: row.height, hidden: row.hidden });
  });
  return { rows: out, unlinked };
};

/** The reader's diagnostic for the cells of `sheet` a hyperlink could not be kept on. */
export const unlinkedDiagnostic = (
  sheet: string,
  addresses: ReadonlyArray<string>,
): Diagnostic => ({
  format: "xlsx",
  stage: "read",
  code: "xlsx.hyperlinkDropped",
  severity: "dropped-content",
  path: [sheet],
  detail: `hyperlinks on ${addresses.length} cell(s) of "${sheet}" that hold no text dropped (${addresses.slice(0, 5).join(", ")}${addresses.length > 5 ? ", …" : ""})`,
});

// ============================================================================
// Writing
// ============================================================================

/** Every `Link` in `inlines`, in document order, nested ones included. */
const linksIn = (inlines: ReadonlyArray<Inline>): ReadonlyArray<Link> =>
  inlines.flatMap((inline): ReadonlyArray<Link> => {
    if (Predicate.isTagged(inline, "Link")) return [inline, ...linksIn(inline.content)];
    return "content" in inline && Array.isArray(inline.content) ? linksIn(inline.content) : [];
  });

/** A cell hyperlink to write: its cell and where it points. */
export interface CellHyperlink {
  readonly ref: string;
  readonly target: Target;
}

/**
 * The hyperlink a rich cell at `ref` is written with: its link's target, over
 * the whole cell. None for a cell without a link. The `Xlsx` profile's `whole`
 * rule keeps a link to a rich cell's only run, which the writer checks first.
 */
export const cellHyperlink = (cell: CellRichText, ref: string): Option.Option<CellHyperlink> =>
  Option.map(Arr.head(linksIn(cell.runs)), (first) => ({ ref, target: first.target }));

/** A worksheet's hyperlinks as `<hyperlinks>` and the relationships its external ones need. */
export interface HyperlinksXml {
  readonly xml: string;
  readonly rels: ReadonlyArray<{ readonly id: string; readonly url: string }>;
}

/**
 * `<hyperlinks>` for `links`, an external URL by a relationship (`rId1`, …) and
 * a `#`-prefixed one by its `location`; nothing for none. The relationships
 * are listed for the worksheet's `_rels` part.
 */
export const hyperlinksXml = (
  links: ReadonlyArray<CellHyperlink>,
  escape: (text: string) => string,
): HyperlinksXml => {
  const rels: Array<{ id: string; url: string }> = [];
  const items = links.map(({ ref, target }) => {
    const tooltip = target.title === undefined ? "" : ` tooltip="${escape(target.title)}"`;
    if (target.url.startsWith("#"))
      return `<hyperlink ref="${ref}" location="${escape(target.url.slice(1))}"${tooltip}/>`;
    const id = `rId${rels.length + 1}`;
    rels.push({ id, url: target.url });
    return `<hyperlink ref="${ref}" r:id="${id}"${tooltip}/>`;
  });
  return {
    xml: Arr.isReadonlyArrayEmpty(items) ? "" : `<hyperlinks>${items.join("")}</hyperlinks>`,
    rels,
  };
};
