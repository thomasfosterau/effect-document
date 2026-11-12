/**
 * Building a worksheet's rows from its cells as they are read, in document
 * order: the steps the XLSX reader's tree path and its `sheetData` scanner
 * share, so both give the same rows.
 */

import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Predicate from "effect/Predicate";
import {
  isPlainRow,
  type PlainCell,
  type RowCell,
  type SheetCell,
  SheetRow,
  sheetRow,
  sheetRowOf,
  type WorksheetRow,
} from "../../index.ts";
import { parseA1 } from "./a1.ts";
import type { SharedString } from "./cellText.ts";
import { spreadsheetMlToCell } from "./cellTypes.ts";
import { translateFormula } from "./formula.ts";
import { findChild, findChildren, type XmlElement } from "./xml.ts";

/** A worksheet's rows, or how many cell positions it holds once it is over its budget. */
export type WorksheetRows =
  | { readonly _tag: "Rows"; readonly rows: ReadonlyArray<WorksheetRow>; readonly cells: number }
  | { readonly _tag: "TooLarge"; readonly cells: number };

/**
 * The plain cell an unstyled text, number or boolean cell is written as (a
 * row holds the bare value, one object fewer a cell); any other cell as it is.
 */
export const plainOrCell = (c: SheetCell): SheetCell | PlainCell =>
  c.style !== undefined
    ? c
    : Predicate.isTagged(c, "CellText") || Predicate.isTagged(c, "CellBoolean")
      ? c.value
      : Predicate.isTagged(c, "CellNumber") && Number.isFinite(c.value)
        ? c.value
        : c;

/** A row's valued cells by column as they are read, and its width so far. */
export interface RowCellsSoFar {
  /** The row's cells by position (its width is their length), gaps `undefined`. */
  readonly cells: Array<SheetCell | PlainCell | undefined>;
}

/** The positions a row grows by to take a cell at `col` (0 when it is already wider). */
export const widen = (row: RowCellsSoFar, col: number): number =>
  col < row.cells.length ? 0 : col + 1 - row.cells.length;

/**
 * Put a cell at `col` of a row, filling any columns before it with gaps (a
 * later cell at a position replaces an earlier one, as in SpreadsheetML).
 */
export const place = (row: RowCellsSoFar, col: number, value: SheetCell | PlainCell): void => {
  const { cells } = row;
  // oxlint-disable-next-line effect/imperative-loops -- once per gap a row's cells leave, beside the per-cell loop
  while (cells.length < col) cells.push(undefined);
  if (col === cells.length) cells.push(value);
  else cells[col] = value;
};

/** Rows by index, as worksheet rows in ascending order. */
const byIndex = Order.mapInput(Order.Number, ([index]: readonly [number, unknown]) => index);

/**
 * The rows read, ascending by index (each row's cells are positional
 * already). Rows may arrive in any order, but writers emit them in order, so
 * the sort is skipped when it would change nothing. A row right after the one
 * before it is a plain row (#227: its cells alone, no node); one after a gap
 * is a `SheetRow` carrying its index.
 */
export const rowsInOrder = (cellMap: ReadonlyMap<number, RowCellsSoFar>): Array<WorksheetRow> => {
  const all = Array.from(cellMap);
  const sorted = all.every((entry, i) => i === 0 || entry[0] > (all[i - 1]?.[0] ?? -1));
  return (sorted ? all : Arr.sort(all, byIndex)).map(([index, { cells }], i, rows) =>
    index === (i === 0 ? 0 : (rows[i - 1]?.[0] ?? -2) + 1) ? cells : sheetRowOf(index, cells),
  );
};

/**
 * A worksheet's rows of valued cells, at most `maxCells` (the budget the
 * workbook has left) cell positions: each row costs its width.
 */
export const parseWorksheetRows = (
  root: XmlElement,
  sharedStrings: ReadonlyArray<SharedString>,
  maxCells: number,
): WorksheetRows => {
  const sheetData = findChild(root, "sheetData");
  if (sheetData === undefined) return { _tag: "Rows", rows: [], cells: 0 };

  // Rows and cells without an `r` attribute follow the previous one.
  const positioned: Array<{ readonly el: XmlElement; readonly row: number; readonly col: number }> =
    [];
  let rowIndex = -1;
  for (const rowEl of findChildren(sheetData, "row")) {
    const rAttr = rowEl.attrs["r"];
    rowIndex = rAttr !== undefined ? Number.parseInt(rAttr, 10) - 1 : rowIndex + 1;
    let colIndex = -1;
    for (const cellEl of findChildren(rowEl, "c")) {
      const ref = cellEl.attrs["r"];
      const parsed = ref === undefined ? null : parseA1(ref);
      colIndex = parsed === null ? colIndex + 1 : parsed.col;
      const row = parsed === null ? rowIndex : parsed.row;
      if (Number.isSafeInteger(row) && row >= 0 && Number.isSafeInteger(colIndex))
        positioned.push({ el: cellEl, row, col: colIndex });
    }
  }

  // Shared formulas keep their text on the master cell only.
  const sharedMasters = new Map<string, { formula: string; row: number; col: number }>();
  for (const { el, row, col } of positioned) {
    const f = findChild(el, "f");
    const si = f?.attrs["si"];
    if (f !== undefined && f.attrs["t"] === "shared" && si !== undefined && f.text !== "") {
      if (!sharedMasters.has(si)) sharedMasters.set(si, { formula: f.text, row, col });
    }
  }

  // Only cells holding a value are kept, so this map is bounded by the input.
  // A later cell at the same position replaces an earlier one.
  // Each row's width is kept beside its cells: the positions the row will
  // hold, grown as its cells arrive, which is what `maxCells` counts.
  const cellMap = new Map<number, RowCellsSoFar>();
  let count = 0;

  for (const { el, row, col } of positioned) {
    const f = findChild(el, "f");
    const master =
      f !== undefined && f.attrs["t"] === "shared" && f.text === ""
        ? sharedMasters.get(f.attrs["si"] ?? "")
        : undefined;
    const formula =
      master === undefined
        ? undefined
        : translateFormula(master.formula, row - master.row, col - master.col);

    const value = spreadsheetMlToCell(el, sharedStrings, formula);
    if (Predicate.isTagged(value, "CellBlank")) continue;

    let rowCells = cellMap.get(row);
    if (rowCells === undefined) {
      rowCells = { cells: [] };
      cellMap.set(row, rowCells);
    }
    count += widen(rowCells, col);
    if (count > maxCells) return { _tag: "TooLarge", cells: count };
    place(rowCells, col, plainOrCell(value));
  }

  return { _tag: "Rows", rows: rowsInOrder(cellMap), cells: count };
};

// ============================================================================
// Row heights and hidden rows (#66)
// ============================================================================

/**
 * What a `<row>` sets that the schema keeps: its custom height in points (a
 * `customHeight` row's `ht`, Excel's mark for a height the user chose; a
 * height Excel only computed is not kept, so a sheet of wrapped text doesn't
 * turn every row into a node) and whether it is hidden.
 */
export interface RowProp {
  readonly index: number;
  readonly height: Option.Option<number>;
  readonly hidden: boolean;
}

/** The {@link RowProp}s of a sheet's rows that set either, by 0-based row index, in document order. */
export type RowProps = ReadonlyArray<RowProp>;

/** A `<row>`'s custom height from its `ht` and `customHeight` values, if it has one. */
const customHeight = (ht: string, custom: string): Option.Option<number> => {
  const height = Number(ht);
  return (custom === "1" || custom === "true") &&
    ht !== "" &&
    Number.isFinite(height) &&
    height >= 0
    ? Option.some(height)
    : Option.none();
};

/** A `<row>`'s attribute by name, whichever way it was read. */
type RowAttribute = (name: string) => string | undefined;

/**
 * The heights and hidden marks of `rows` (each a `<row>`'s attributes), in
 * order: a row without an `r` follows the one before, as the rows themselves
 * are read.
 */
const propsOf = (rows: ReadonlyArray<RowAttribute>): RowProps =>
  rows.reduce<{ index: number; props: Array<RowProp> }>(
    (acc, attr) => {
      const r = attr("r");
      acc.index = r === undefined ? acc.index + 1 : Number.parseInt(r, 10) - 1;
      const height = customHeight(attr("ht") ?? "", attr("customHeight") ?? "");
      const hiddenValue = attr("hidden");
      const hidden = hiddenValue === "1" || hiddenValue === "true";
      if ((Option.isSome(height) || hidden) && Number.isSafeInteger(acc.index) && acc.index >= 0)
        acc.props.push({ index: acc.index, height, hidden });
      return acc;
    },
    { index: -1, props: [] },
  ).props;

/** The heights and hidden marks of a parsed worksheet's rows (the tree path). */
export const treeRowProps = (root: XmlElement): RowProps => {
  const sheetData = findChild(root, "sheetData");
  return sheetData === undefined
    ? []
    : propsOf(
        findChildren(sheetData, "row").map(
          (el): RowAttribute =>
            (name) =>
              el.attrs[name],
        ),
      );
};

/** A `<row>` start tag and its attributes (for {@link textRowProps}). */
const ROW_TAG = /<row(?=[\s/>])([^>]*)>/g;
/** One attribute of a start tag: its name, then its value in either quote. */
const ATTRIBUTE = /\s([A-Za-z]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/** A start tag's attributes, by name. */
const attributesOf = (tag: string): ReadonlyMap<string, string> =>
  new Map(Array.from(tag.matchAll(ATTRIBUTE), (m) => [m[1] ?? "", m[2] ?? m[3] ?? ""] as const));

/**
 * The heights and hidden marks of a worksheet part's rows read from its
 * text, for the `sheetData` scanner's path (which keeps no element tree); the
 * reader calls it only when the scanner saw a `customHeight` or `hidden` on a
 * row. The scanner only succeeds on plain markup (no comment, CDATA or
 * prefix), so every `<row` in the part is a row.
 */
export const textRowProps = (xml: string): RowProps =>
  propsOf(
    Array.from(xml.matchAll(ROW_TAG), (m): RowAttribute => {
      const attrs = attributesOf(m[1] ?? "");
      return (name) => attrs.get(name);
    }),
  );

/** A row's cells, whichever form it is in. */
const cellsOfRow = (row: WorksheetRow): ReadonlyArray<SheetCell | PlainCell | undefined> =>
  isPlainRow(row) ? row : row.cells;

/** A row with what `prop` sets: its height, and `hidden` only when it is hidden. */
const rowWith = (index: number, cells: ReadonlyArray<RowCell>, prop: RowProp): SheetRow => {
  const height = Option.getOrUndefined(prop.height);
  return prop.hidden
    ? new SheetRow({ index, cells: Array.from(cells), height, hidden: true })
    : sheetRow(index, cells, height);
};

/**
 * `rows` with `props` set: a row with a height or a hidden mark becomes a
 * `SheetRow` carrying it, and one for a row with no valued cells adds an
 * empty `SheetRow` (the one thing such a row is for); the rest keep their
 * form, plain where they follow on. `added` is how many rows the props
 * added, which the reader counts toward `maxCells` as a cell each. The rows
 * are returned unchanged when there are no props.
 */
export const withRowProps = (rows: ReadonlyArray<WorksheetRow>, props: RowProps): RowsWithProps => {
  if (Arr.isReadonlyArrayEmpty(props)) return { rows, added: 0 };
  const propAt = new Map(props.map((prop) => [prop.index, prop] as const));
  const cellsAt = new Map(
    rowIndexesOf(rows).map((index, k) => [index, cellsOfRow(rows[k] ?? [])] as const),
  );
  const present = cellsAt.size;
  propAt.forEach((_, index) => {
    if (!cellsAt.has(index)) cellsAt.set(index, []);
  });
  const indexes = Arr.sort(Array.from(cellsAt.keys()), Order.Number);
  const out = indexes.map((index, k): WorksheetRow => {
    const cells = cellsAt.get(index) ?? [];
    const prop = propAt.get(index);
    if (prop !== undefined) return rowWith(index, cells, prop);
    return index === (k === 0 ? 0 : (indexes[k - 1] ?? -2) + 1) && endsInCell(cells)
      ? Array.from(cells)
      : sheetRowOf(index, cells);
  });
  return { rows: out, added: cellsAt.size - present };
};

/** {@link withRowProps}'s result: the rows, and how many rows the props added. */
export interface RowsWithProps {
  readonly rows: ReadonlyArray<WorksheetRow>;
  readonly added: number;
}

/** The 0-based index of each of `rows`, a plain row's being one past the row before it. */
const rowIndexesOf = (rows: ReadonlyArray<WorksheetRow>): ReadonlyArray<number> =>
  rows.reduce<Array<number>>((acc, row) => {
    acc.push(isPlainRow(row) ? (acc.at(-1) ?? -1) + 1 : row.index);
    return acc;
  }, []);

/** Whether a row's cells end in a cell, as a plain row's must (an empty row is a `SheetRow`). */
const endsInCell = (cells: ReadonlyArray<SheetCell | PlainCell | undefined>): boolean =>
  cells.at(-1) !== undefined;
