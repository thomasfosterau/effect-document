/**
 * Views and constructors over the sparse worksheet: a `Worksheet` holds only
 * the rows it has, each holding only the cells it has, so these derive the
 * dense grid (and its extent) for callers that want one, and build sparse rows
 * from dense ones.
 */

import * as Arr from "effect/Array";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { CellBlank, PlainCell, type RowCell, SheetCell, SheetRow, type Worksheet } from "./ast.ts";
import {
  isCellInstance,
  positional,
  trustedBoolean,
  trustedNumber,
  trustedRowOf,
  trustedSparseRow,
  trustedText,
} from "./trusted.ts";

/** A worksheet's extent: one past its last row index and one past its last column. */
export interface SheetExtent {
  readonly rows: number;
  readonly columns: number;
}

/**
 * The extent of a worksheet: `rows` is one past the last row's index (rows
 * without cells count, since they exist to carry a height) and `columns` one
 * past the rightmost cell's column. `{ rows: 0, columns: 0 }` for an empty
 * sheet. Linear in the rows the sheet holds.
 */
export const sheetExtent = (ws: Worksheet): SheetExtent => {
  const last = ws.rows.at(-1);
  const columns = ws.rows.reduce((m, row) => Math.max(m, row.cells.length), 0);
  return { rows: last === undefined ? 0 : last.index + 1, columns };
};

/**
 * The default {@link DenseRowsOptions.maxCells}: five million cells, the same
 * budget the XLSX reader allows a workbook's valued cells.
 */
export const DEFAULT_MAX_DENSE_CELLS = 5_000_000;

/** A worksheet's dense grid would be larger than the budget it was asked for under. */
export class DenseGridTooLarge extends Schema.TaggedError<DenseGridTooLarge>()(
  "DenseGridTooLarge",
  {
    /** The cells (plus one per row) the dense grid would allocate. */
    cells: Schema.Number,
    /** The budget it exceeded. */
    maxCells: Schema.Number,
  },
) {
  override get message(): string {
    return `A dense grid of ${this.cells} cells exceeds the ${this.maxCells}-cell budget`;
  }
}

/** Options for {@link denseRows} and {@link denseSize}. */
export interface DenseRowsOptions {
  /**
   * Pad every row to the sheet's column extent (the default), giving a
   * rectangular grid; `false` keeps each row as long as its own last cell.
   */
  readonly rectangular?: boolean | undefined;
  /**
   * The most cells the grid may allocate, counting one per row as well (a
   * row costs an array even when empty). Defaults to
   * {@link DEFAULT_MAX_DENSE_CELLS}.
   */
  readonly maxCells?: number | undefined;
}

/** The width of a row's dense form: one past its last cell's column. */
const rowWidth = (row: SheetRow): number => row.cells.length;

/**
 * The cells {@link denseRows} would allocate for a worksheet, plus one per
 * row: `rows × (columns + 1)` for a rectangular grid, or the rows plus each
 * held row's own width otherwise. Linear in the rows the sheet holds.
 */
export const denseSize = (ws: Worksheet, options?: DenseRowsOptions): number => {
  const extent = sheetExtent(ws);
  return (options?.rectangular ?? true)
    ? extent.rows * (extent.columns + 1)
    : ws.rows.reduce((n, row) => n + rowWidth(row), extent.rows);
};

/** A row's cells from column 0 to `width`, each gap a fresh unstyled blank. */
const denseCells = (row: SheetRow | undefined, width: number): ReadonlyArray<SheetCell> =>
  Array.from({ length: width }, (_, col) => cellOf(row?.cells[col]) ?? new CellBlank());

/**
 * The derived dense view of a worksheet: one array per row from row 0 to the
 * last row, each holding the row's cells by column with every gap a fresh
 * unstyled {@link CellBlank}; a row the sheet does not hold is all blanks
 * (empty when not `rectangular`).
 *
 * The grid is the sheet's extent, which can be far larger than the cells it
 * holds (one value at A1 and one at XFD1048576 is 17 billion cells), so it is
 * built only within a budget (`maxCells`, see {@link denseSize}) and fails with
 * {@link DenseGridTooLarge} past it, before allocating anything.
 */
export const denseRows = (
  ws: Worksheet,
  options?: DenseRowsOptions,
): Result.Result<ReadonlyArray<ReadonlyArray<SheetCell>>, DenseGridTooLarge> => {
  const maxCells = options?.maxCells ?? DEFAULT_MAX_DENSE_CELLS;
  const cells = denseSize(ws, options);
  if (cells > maxCells) return Result.fail(new DenseGridTooLarge({ cells, maxCells }));
  const rectangular = options?.rectangular ?? true;
  const width = sheetExtent(ws).columns;
  // The rows are in ascending index order, so one cursor walks them.
  let next = 0;
  return Result.succeed(
    Array.from({ length: sheetExtent(ws).rows }, (_, index) => {
      const held = ws.rows[next];
      const row = held?.index === index ? held : undefined;
      if (row !== undefined) next += 1;
      return denseCells(row, rectangular ? width : row === undefined ? 0 : rowWidth(row));
    }),
  );
};

/** Whether a value is a row or column position: a non-negative safe integer. */
const isPosition = (n: number): boolean => Number.isSafeInteger(n) && n >= 0;

/** Whether a height is absent or a number, as `SheetRow` accepts. */
const isHeight = (height: number | undefined): boolean =>
  height === undefined || Predicate.isNumber(height);

/** Whether a value is a plain cell: a finite number, a string or a boolean. */
const isPlainCell = (value: unknown): boolean =>
  Predicate.isString(value) ||
  Predicate.isBoolean(value) ||
  (Predicate.isNumber(value) && Number.isFinite(value));

/**
 * The cell node a row position holds: the node itself, the unstyled
 * `CellText` / `CellNumber` / `CellBoolean` a plain cell stands for, or
 * `undefined` for a gap. A plain cell's node is built when asked for (two
 * calls give equal nodes, not the same one).
 *
 * @example
 * ```ts
 * import { cellOf } from "@thomasfosterau/effect-document"
 *
 * cellOf(42) // CellNumber { value: 42 }
 * ```
 */
export const cellOf = (position: RowCell): SheetCell | undefined =>
  position === undefined
    ? undefined
    : Predicate.isString(position)
      ? trustedText(position)
      : Predicate.isNumber(position)
        ? trustedNumber(position)
        : Predicate.isBoolean(position)
          ? trustedBoolean(position)
          : position;

/**
 * The cell node at column `col` of a row (see {@link cellOf}), or `undefined`
 * where the row has no cell.
 *
 * @example
 * ```ts
 * import { cellAt, sheetRow } from "@thomasfosterau/effect-document"
 *
 * cellAt(sheetRow(0, ["a", 1]), 1) // CellNumber { value: 1 }
 * ```
 */
export const cellAt = (row: SheetRow, col: number): SheetCell | undefined => cellOf(row.cells[col]);

/**
 * Whether positional cells are what `SheetRow` accepts unchanged: each a cell
 * instance, a plain cell or `undefined` (a gap), the last not a gap.
 */
const isPositional = (cells: ReadonlyArray<RowCell>): boolean =>
  cells.every((cell) => cell === undefined || isPlainCell(cell) || isCellInstance(cell)) &&
  (Arr.isReadonlyArrayEmpty(cells) || cells.at(-1) !== undefined);

/**
 * A row from its cells by position: the cell at array position `n` goes to
 * column `n` (a node, or a plain number, string or boolean standing for its
 * unstyled node), and `undefined` is a gap (no cell in that column); the last
 * position must hold a cell. The array is copied. Every cell is kept, blanks
 * included, so the row reads back exactly as given; anything `SheetRow` would
 * reject fails as `new SheetRow` does.
 *
 * @example
 * ```ts
 * import { cell, sheetRow } from "@thomasfosterau/effect-document"
 *
 * // A1 and C1, with B1 a gap
 * sheetRow(0, [cell.text("a"), undefined, cell.number(3)])
 * ```
 */
export const sheetRow = (
  index: number,
  cells: ReadonlyArray<RowCell>,
  height?: number,
): SheetRow =>
  // the schema pass would accept these unchanged, so skip it; anything else
  // is checked and fails as before
  isPosition(index) && isHeight(height) && isPositional(cells)
    ? trustedRowOf(index, cells.slice(), height)
    : new SheetRow({ index, cells, height });

/**
 * A row holding `cells` as its own array (not copied: the caller hands it
 * over and must not change it after), as {@link sheetRow} otherwise: readers
 * build one array per line of a file and need not copy it again.
 *
 * @example
 * ```ts
 * import { cell, sheetRowOf } from "@thomasfosterau/effect-document"
 *
 * sheetRowOf(0, [cell.text("a"), cell.number(1)])
 * ```
 */
export const sheetRowOf = (index: number, cells: ReadonlyArray<RowCell>): SheetRow =>
  isPosition(index) && isPositional(cells)
    ? trustedRowOf(index, cells)
    : new SheetRow({ index, cells, height: undefined });

/**
 * A dense row built from any values: the cell at column `n` is
 * `toCell(items[n], n)`. It is `sheetRowOf(index, items.map(toCell))`, and
 * fails as `sheetRow` does.
 *
 * @example
 * ```ts
 * import { cell, sheetRowFrom } from "@thomasfosterau/effect-document"
 *
 * sheetRowFrom(0, ["a", "b"], (value) => cell.text(value))
 * ```
 */
export const sheetRowFrom = <A>(
  index: number,
  items: ReadonlyArray<A>,
  toCell: (item: A, col: number) => SheetCell,
): SheetRow => sheetRowOf(index, items.map(toCell));

/**
 * The cells a row holds with their columns, in ascending column order (the
 * gaps left out), each as its node (see {@link cellOf}): for code that walks
 * only the cells present.
 *
 * @example
 * ```ts
 * import { cell, rowEntries, sheetRow } from "@thomasfosterau/effect-document"
 *
 * rowEntries(sheetRow(0, [cell.text("a"), undefined, cell.number(3)]))
 * // [[0, CellText], [2, CellNumber]]
 * ```
 */
export const rowEntries = (row: SheetRow): ReadonlyArray<readonly [col: number, cell: SheetCell]> =>
  row.cells.flatMap((position, col) => {
    const cell = cellOf(position);
    return cell === undefined ? [] : [[col, cell] as const];
  });

/**
 * A row from its cells' `[column, cell]` entries (a node or a plain cell),
 * in strictly ascending column order: the readers' constructor for rows whose cells skip columns
 * (every column between two entries is a gap). Entries that are out of
 * order, or a column that is not a non-negative integer, fail with a
 * `SchemaError` as `new SheetRow` does; valid ones skip its schema pass, as
 * `sheetRow` does.
 *
 * @example
 * ```ts
 * import { cell, sparseRow } from "@thomasfosterau/effect-document"
 *
 * // A1 and C1, with B1 a gap
 * sparseRow(0, [[0, cell.text("a")], [2, cell.number(3)]])
 * ```
 */
export const sparseRow = (
  index: number,
  entries: ReadonlyArray<readonly [col: number, cell: SheetCell | PlainCell]>,
  height?: number,
): SheetRow =>
  isPosition(index) &&
  isHeight(height) &&
  entries.every(
    ([col, cell], i) =>
      isPosition(col) &&
      (isPlainCell(cell) || isCellInstance(cell)) &&
      (i === 0 || col > (entries[i - 1]?.[0] ?? -1)),
  )
    ? trustedSparseRow(index, entries, height)
    : validatedSparseRow(index, entries, height);

/** A column: a non-negative integer. */
const Column = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** Entries whose columns strictly ascend, as {@link sparseRow} takes them. */
const SparseEntries = Schema.Array(
  Schema.Tuple([Column, Schema.Union([PlainCell, SheetCell])]),
).check(
  Schema.makeFilter<ReadonlyArray<readonly [number, SheetCell | PlainCell]>>(
    (entries) =>
      entries.flatMap(([col], i): Array<Schema.FilterIssue> => {
        const previous = entries[i - 1]?.[0];
        return previous !== undefined && col <= previous
          ? [{ path: [i, 0], issue: `column ${col} is not after ${previous}` }]
          : [];
      }),
    {
      identifier: "SparseRowColumnsAscending",
      title: "entries in ascending column order",
      description: "A sparse row's entries have strictly ascending columns: each column once.",
    },
  ),
);

/** {@link sparseRow}'s validating path: the entries checked, then `new SheetRow`, with no `height` key unless one is given. */
const validatedSparseRow = (
  index: number,
  entries: ReadonlyArray<readonly [col: number, cell: SheetCell | PlainCell]>,
  height?: number,
): SheetRow => {
  const cells = positional(Schema.decodeUnknownSync(SparseEntries)(entries));
  return height === undefined
    ? new SheetRow({ index, cells })
    : new SheetRow({ index, cells, height });
};
