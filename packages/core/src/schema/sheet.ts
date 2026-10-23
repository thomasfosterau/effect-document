/**
 * Views and constructors over the sparse worksheet: a `Worksheet` holds only
 * the rows it has, each holding only the cells it has, so these derive the
 * dense grid (and its extent) for callers that want one, and build sparse rows
 * from dense ones.
 */

import { CellBlank, IndexedCell, type SheetCell, SheetRow, type Worksheet } from "./ast.ts";

/** A worksheet's extent: one past its last row index and one past its last column. */
export interface SheetExtent {
  readonly rows: number;
  readonly columns: number;
}

/**
 * The extent of a worksheet: `rows` is one past the last row's index (rows
 * without cells count, since they exist to carry a height) and `columns` one
 * past the rightmost cell's column. `{ rows: 0, columns: 0 }` for an empty
 * sheet. Linear in the cells the sheet holds, so it is the check to make
 * before asking for {@link denseRows} on input you do not control.
 */
export const sheetExtent = (ws: Worksheet): SheetExtent => {
  const last = ws.rows.at(-1);
  const columns = ws.rows.reduce((m, row) => Math.max(m, (row.cells.at(-1)?.col ?? -1) + 1), 0);
  return { rows: last === undefined ? 0 : last.index + 1, columns };
};

/**
 * A row's cells as a dense array from column 0, at least `width` long: each
 * gap (and the padding past the row's last cell) is a fresh unstyled
 * {@link CellBlank}. Allocates the row's extent, not just its cells.
 */
export const denseCells = (row: SheetRow, width = 0): ReadonlyArray<SheetCell> => {
  // The cells are in ascending column order, so one cursor walks them.
  let next = 0;
  return Array.from({ length: Math.max(width, (row.cells.at(-1)?.col ?? -1) + 1) }, (_, col) => {
    const entry = row.cells[next];
    if (entry?.col !== col) return new CellBlank();
    next += 1;
    return entry.cell;
  });
};

/** Options for {@link denseRows}. */
export interface DenseRowsOptions {
  /**
   * Pad every row to the sheet's column extent (the default), giving a
   * rectangular grid; `false` keeps each row as long as its own last cell.
   */
  readonly rectangular?: boolean | undefined;
}

/**
 * The derived dense view of a worksheet: one array per row from row 0 to the
 * last row, each a dense array of cells (see {@link denseCells}); a row the
 * sheet does not hold is all blanks (empty when not `rectangular`).
 *
 * This allocates the sheet's extent, which can be far larger than the cells
 * it holds (one value at A1 and one at XFD1048576), so check
 * {@link sheetExtent} first when the sheet came from untrusted input.
 */
export const denseRows = (
  ws: Worksheet,
  options?: DenseRowsOptions,
): ReadonlyArray<ReadonlyArray<SheetCell>> => {
  const extent = sheetExtent(ws);
  const width = (options?.rectangular ?? true) ? extent.columns : 0;
  const empty = new SheetRow({ index: 0, cells: [] });
  // The rows are in ascending index order, so one cursor walks them.
  let next = 0;
  return Array.from({ length: extent.rows }, (_, index) => {
    const row = ws.rows[next];
    if (row?.index !== index) return denseCells(empty, width);
    next += 1;
    return denseCells(row, width);
  });
};

/**
 * A sparse row from a dense array of cells: the cell at array position `n`
 * goes to column `n`. Every cell is kept, blanks included, so the row reads
 * back exactly as given; drop unstyled blanks first for a sparse row.
 */
export const sheetRow = (
  index: number,
  cells: ReadonlyArray<SheetCell>,
  height?: number | undefined,
): SheetRow =>
  new SheetRow({
    index,
    cells: cells.map((cell, col) => new IndexedCell({ col, cell })),
    height,
  });
