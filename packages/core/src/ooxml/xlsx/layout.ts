/**
 * A worksheet's layout (#66): its column widths (`<cols>`) and merged ranges
 * (`<mergeCells>`), read from the parsed part and written around its
 * `sheetData`. Both are per sheet, a handful of elements, so they are read
 * from the element tree on both of the reader's paths.
 */

import * as Arr from "effect/Array";
import * as Result from "effect/Result";
import {
  MergeRange,
  rowIndexes,
  SheetColumn,
  withSheetLayout,
  type Worksheet,
} from "../../index.ts";
import { parseA1Range, toA1 } from "./a1.ts";
import { findChild, findChildren, getAttr, type XmlElement } from "./xml.ts";

/** The most columns a worksheet has (`XFD`): a `<col>` range is cut there. */
export const MAX_COLUMNS = 16_384;

/** A `<col>` element's range and width, 0-based and inclusive. */
interface ColumnSpan {
  readonly from: number;
  readonly to: number;
  readonly width: number;
}

/** A `<col>`'s span when it has a positive width and a range within the sheet's columns; otherwise none. */
const spanOf = (col: XmlElement): ReadonlyArray<ColumnSpan> => {
  const min = Number(getAttr(col, "min"));
  const max = Number(getAttr(col, "max"));
  const width = Number(getAttr(col, "width"));
  return Number.isInteger(min) &&
    Number.isInteger(max) &&
    min >= 1 &&
    max >= min &&
    width > 0 &&
    Number.isFinite(width)
    ? [{ from: min - 1, to: Math.min(max, MAX_COLUMNS) - 1, width }]
    : [];
};

/**
 * A worksheet's column widths, one `SheetColumn` per column up to the last
 * with a width (the width in characters of the default font, as `col/@width`
 * has it); none when no `<col>` sets one. A column no `<col>` covers is a
 * `SheetColumn` without a width. A `<col>` without a width (a style or
 * visibility only) adds nothing: neither is in the profile yet.
 */
const readColumns = (root: XmlElement): ReadonlyArray<SheetColumn> => {
  const cols = findChild(root, "cols");
  const spans = cols === undefined ? [] : findChildren(cols, "col").flatMap(spanOf);
  if (Arr.isReadonlyArrayEmpty(spans)) return [];
  const widths = Arr.makeBy(
    Math.max(...spans.map((s) => s.to)) + 1,
    (): number | undefined => undefined,
  );
  spans.forEach(({ from, to, width }) => {
    widths.fill(width, from, to + 1);
  });
  return widths.map((width) =>
    width === undefined ? new SheetColumn({}) : new SheetColumn({ width }),
  );
};

/**
 * A worksheet's merged ranges, in the order `<mergeCells>` lists them; a
 * failure naming the first `ref` that is not an A1 range (Excel refuses such a
 * file too).
 */
const readMerges = (root: XmlElement): Result.Result<ReadonlyArray<MergeRange>, string> => {
  const merges = findChild(root, "mergeCells");
  const refs = merges === undefined ? [] : findChildren(merges, "mergeCell");
  return Result.all(
    refs.map((el) => {
      const ref = getAttr(el, "ref") ?? "";
      const range = parseA1Range(ref);
      return range === null
        ? Result.fail(`a merged range whose ref is not an A1 range: "${ref}"`)
        : Result.succeed(
            new MergeRange({
              fromRow: Math.min(range.start.row, range.end.row),
              fromCol: Math.min(range.start.col, range.end.col),
              toRow: Math.max(range.start.row, range.end.row),
              toCol: Math.max(range.start.col, range.end.col),
            }),
          );
    }),
  );
};

/**
 * The merges that start at or above row `lastRow`, each cut to end there: what
 * a preview read (`maxRows`) keeps of a sheet's merges, so a truncated sheet
 * holds no range over rows it doesn't have. None when `lastRow` is -1 (no rows).
 */
const mergesWithin = (
  merges: ReadonlyArray<MergeRange>,
  lastRow: number,
): ReadonlyArray<MergeRange> =>
  merges.flatMap((m) =>
    m.fromRow > lastRow
      ? []
      : m.toRow <= lastRow
        ? [m]
        : [
            new MergeRange({
              fromRow: m.fromRow,
              fromCol: m.fromCol,
              toRow: lastRow,
              toCol: m.toCol,
            }),
          ],
  );

/** A merged range's A1 reference, or why it has none (a corner that is not a cell position, or corners out of order). */
const mergeRef = (m: MergeRange): Result.Result<string, string> => {
  const corners = [m.fromRow, m.fromCol, m.toRow, m.toCol];
  if (!corners.every((n) => Number.isInteger(n) && n >= 0))
    return Result.fail("a merged range's corners must be non-negative integers");
  if (m.toRow < m.fromRow || m.toCol < m.fromCol)
    return Result.fail("a merged range must end at or after where it starts");
  if (m.toCol >= MAX_COLUMNS)
    return Result.fail(`a merged range must end within the sheet's ${MAX_COLUMNS} columns`);
  return Result.succeed(`${toA1(m.fromCol, m.fromRow)}:${toA1(m.toCol, m.toRow)}`);
};

/** `<mergeCells>` for `merges`, or nothing for none; a failure for a range that has no A1 reference. */
export const mergeCellsXml = (merges: ReadonlyArray<MergeRange>): Result.Result<string, string> =>
  Arr.isReadonlyArrayEmpty(merges)
    ? Result.succeed("")
    : Result.map(
        Result.all(merges.map(mergeRef)),
        (refs) =>
          `<mergeCells count="${refs.length}">${refs.map((ref) => `<mergeCell ref="${ref}"/>`).join("")}</mergeCells>`,
      );

/** Consecutive columns of one width, as one `<col>`: 0-based and inclusive. */
const runsOf = (columns: ReadonlyArray<SheetColumn>): ReadonlyArray<ColumnSpan> =>
  columns.reduce<Array<ColumnSpan>>((runs, column, i) => {
    const { width } = column;
    if (width === undefined || !(width > 0) || !Number.isFinite(width)) return runs;
    const last = runs.at(-1);
    if (last !== undefined && last.to === i - 1 && last.width === width)
      runs[runs.length - 1] = { ...last, to: i };
    else runs.push({ from: i, to: i, width });
    return runs;
  }, []);

/**
 * `<cols>` for the columns that have a width, consecutive columns of one
 * width as one `<col>` (as Excel writes them), or nothing when none has one.
 * Columns past {@link MAX_COLUMNS} are not written: a sheet has no such column.
 */
export const colsXml = (columns: ReadonlyArray<SheetColumn>): string => {
  const runs = runsOf(columns.slice(0, MAX_COLUMNS));
  return Arr.isReadonlyArrayEmpty(runs)
    ? ""
    : `<cols>${runs
        .map(
          ({ from, to, width }) =>
            `<col min="${from + 1}" max="${to + 1}" width="${width}" customWidth="1"/>`,
        )
        .join("")}</cols>`;
};

/**
 * `sheet` (its rows already read) with the layout its part's `root` declares:
 * its column widths and merged ranges, set without checking the rows again. A
 * `truncated` sheet (a preview read, `maxRows`) keeps only the merges over the
 * rows it kept ({@link mergesWithin}). A failure names a merge `ref` that is not
 * an A1 range.
 */
export const withLayoutOf = (
  sheet: Worksheet,
  root: XmlElement,
  truncated: boolean,
): Result.Result<Worksheet, string> =>
  Result.map(readMerges(root), (merges) => {
    const columns = readColumns(root);
    const kept = truncated ? mergesWithin(merges, rowIndexes(sheet).at(-1) ?? -1) : merges;
    return Arr.isReadonlyArrayEmpty(columns) && Arr.isReadonlyArrayEmpty(kept)
      ? sheet
      : withSheetLayout(sheet, columns, kept);
  });
