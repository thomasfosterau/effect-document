/**
 * Building a worksheet's rows from its cells as they are read, in document
 * order: the steps the XLSX reader's tree path and its `sheetData` scanner
 * share, so both give the same rows.
 */

import * as Arr from "effect/Array";
import * as Order from "effect/Order";
import * as Predicate from "effect/Predicate";
import {
  type PlainCell,
  type SheetCell,
  sheetRowOf,
  type WorksheetRow,
} from "@thomasfosterau/effect-document";
import { parseA1 } from "./a1.ts";
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
  sharedStrings: ReadonlyArray<string>,
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
