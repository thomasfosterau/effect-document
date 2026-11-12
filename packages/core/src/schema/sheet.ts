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
import {
  CellBlank,
  isPlainRow,
  MergeRange,
  PlainCell,
  type RowCell,
  SheetCell,
  SheetColumn,
  type SheetVisibility,
  SheetRow,
  Worksheet,
  type WorksheetRow,
} from "./ast.ts";
import {
  isCellInstance,
  positional,
  trustedWorksheet,
  trustedWorksheetLayout,
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
 * A worksheet row's cells by position, whether it is a {@link SheetRow} or a
 * plain row (#227): no node is built.
 *
 * @example
 * ```ts
 * import { rowCellsOf, sheetRow } from "@thomasfosterau/effect-document"
 *
 * rowCellsOf(["a", 1]) // ["a", 1]
 * rowCellsOf(sheetRow(3, ["a", 1])) // ["a", 1]
 * ```
 */
export const rowCellsOf = (row: WorksheetRow): ReadonlyArray<RowCell> =>
  isPlainRow(row) ? row : row.cells;

/**
 * The index of each of a worksheet's rows, in order: a {@link SheetRow}'s
 * own, and a plain row's one past the row before it (row 0 when first). One
 * array for the sheet, so a caller walking `rows` by position pays nothing
 * per row for it.
 *
 * @example
 * ```ts
 * import { rowIndexes, sheetRow, worksheetFromRows } from "@thomasfosterau/effect-document"
 *
 * rowIndexes(worksheetFromRows("S", [["a"], sheetRow(4, ["b"]), ["c"]])) // [0, 4, 5]
 * ```
 */
export const rowIndexes = (ws: Worksheet): ReadonlyArray<number> => {
  let previous = -1;
  return ws.rows.map((row) => {
    previous = isPlainRow(row) ? previous + 1 : row.index;
    return previous;
  });
};

/**
 * A worksheet's rows as {@link SheetRow} nodes, in order: a `SheetRow` as it
 * is, and each plain row as the node it stands for (built when asked for, so
 * two calls give equal nodes, not the same ones). For code that wants nodes;
 * {@link rowIndexes} and {@link rowCellsOf} read a sheet without building any.
 *
 * @example
 * ```ts
 * import { rowsOf, worksheetFromRows } from "@thomasfosterau/effect-document"
 *
 * rowsOf(worksheetFromRows("S", [["a"], ["b"]])).map((row) => row.index) // [0, 1]
 * ```
 */
export const rowsOf = (ws: Worksheet): ReadonlyArray<SheetRow> => {
  const indexes = rowIndexes(ws);
  // a plain row was checked as the sheet was built: its node is the trusted one
  return ws.rows.map((row, i) => (isPlainRow(row) ? trustedRowOf(indexes[i] ?? i, row) : row));
};

/**
 * The extent of a worksheet: `rows` is one past the last row's index (rows
 * without cells count, since they exist to carry a height) and `columns` one
 * past the rightmost cell's column. `{ rows: 0, columns: 0 }` for an empty
 * sheet. Linear in the rows the sheet holds.
 */
export const sheetExtent = (ws: Worksheet): SheetExtent => {
  const indexes = rowIndexes(ws);
  const columns = ws.rows.reduce((m, row) => Math.max(m, rowCellsOf(row).length), 0);
  const last = indexes.at(-1);
  return { rows: last === undefined ? 0 : last + 1, columns };
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
const rowWidth = (row: WorksheetRow): number => rowCellsOf(row).length;

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
const denseCells = (
  cells: ReadonlyArray<RowCell> | undefined,
  width: number,
): ReadonlyArray<SheetCell> =>
  Array.from({ length: width }, (_, col) => cellOf(cells?.[col]) ?? new CellBlank());

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
  const indexes = rowIndexes(ws);
  // The rows are in ascending index order, so one cursor walks them.
  let next = 0;
  return Result.succeed(
    Array.from({ length: sheetExtent(ws).rows }, (_, index) => {
      const held = indexes[next] === index ? ws.rows[next] : undefined;
      if (held !== undefined) next += 1;
      const heldCells = held === undefined ? undefined : rowCellsOf(held);
      return denseCells(heldCells, rectangular ? width : (heldCells?.length ?? 0));
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
 * Whether a value may stand at a row position: a gap, a plain cell or a cell
 * node. Numbers first: a reader's rows are mostly numbers, and this runs once
 * per cell a reader builds (bench/csv.bench.ts).
 */
const isRowCellValue = (value: unknown): boolean =>
  Predicate.isNumber(value)
    ? Number.isFinite(value)
    : value === undefined ||
      Predicate.isString(value) ||
      Predicate.isBoolean(value) ||
      isCellInstance(value);

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
export const cellAt = (row: WorksheetRow, col: number): SheetCell | undefined =>
  cellOf(rowCellsOf(row)[col]);

/**
 * Whether positional cells are what `SheetRow` accepts unchanged: each a cell
 * instance, a plain cell or `undefined` (a gap), the last not a gap.
 */
const isPositional = (cells: ReadonlyArray<RowCell>): boolean =>
  cells.every(isRowCellValue) && (Arr.isReadonlyArrayEmpty(cells) || cells.at(-1) !== undefined);

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
export const sheetRow = (index: number, cells: ReadonlyArray<RowCell>, height?: number): SheetRow =>
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
 * {@link sheetRowOf} for a row its caller expects to hold only plain numbers
 * (a reader's row of a table of numbers): the same row, from the same
 * array, with the same failures. Its check of the numbers is its own, so it
 * only ever meets arrays of numbers, which V8 holds as unboxed doubles and
 * reads without boxing; `sheetRowOf`'s check meets every kind of row and
 * boxes each number it reads from such an array (a heap number per cell).
 * A row holding anything else is handed to `sheetRowOf`.
 *
 * @example
 * ```ts
 * import { sheetRowOfNumbers } from "@thomasfosterau/effect-document"
 *
 * sheetRowOfNumbers(0, [1.5, 2, -3])
 * ```
 */
export const sheetRowOfNumbers = (index: number, cells: ReadonlyArray<RowCell>): SheetRow =>
  isPositionalNumbers(cells) && isPosition(index)
    ? trustedRowOf(index, cells)
    : sheetRowOf(index, cells);

/**
 * Whether a row's cells are all plain finite numbers (and there is at least
 * one), checked by a loop of its own: called only for arrays of doubles, it
 * reads them without boxing, where `every` boxes each number to pass it to
 * its callback (9.7 MB of the CSV reader's 31.6 MB a read of
 * bench/csv.bench.ts's numbers table).
 */
const isPositionalNumbers = (cells: ReadonlyArray<RowCell>): boolean => {
  const n = cells.length;
  let numbers = n > 0;
  // oxlint-disable-next-line effect/imperative-loops -- once per cell of a row of numbers: `every` boxes each number of an array of doubles to pass it to its callback (see above)
  for (let i = 0; numbers && i < n; i++) {
    const value = cells[i];
    numbers = Predicate.isNumber(value) && Number.isFinite(value);
  }
  return numbers;
};

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
export const rowEntries = (
  row: WorksheetRow,
): ReadonlyArray<readonly [col: number, cell: SheetCell]> =>
  rowCellsOf(row).flatMap((position, col) => {
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

/**
 * A worksheet of finished rows, for readers that build each row as they go:
 * `SheetRow`s (`sheetRow`, `sparseRow`) and plain rows (a row's cells alone,
 * standing for the row one past the one before it, #227). Rows that are what
 * `Worksheet` accepts unchanged (instances or positional cell arrays, in
 * strictly ascending index order) skip the schema pass; anything else is
 * checked and fails as `new Worksheet` does.
 *
 * `numberRows`, ascending, lists the positions of the rows the caller
 * expects to be plain rows of numbers (a reader's rows of a table of
 * numbers): they are checked by a loop that only ever meets arrays of
 * doubles, which V8 then reads without boxing each number. It changes only
 * the speed: a listed row that is not one is checked as any other.
 *
 * @example
 * ```ts
 * import { cell, sheetRow, worksheetFromRows } from "@thomasfosterau/effect-document"
 *
 * worksheetFromRows("Sheet1", [sheetRow(0, [cell.text("a")]), sheetRow(2, [cell.number(1)])])
 * // rows 0 and 1, as plain rows
 * worksheetFromRows("Sheet1", [["a", 1], ["b", 2]])
 * ```
 */
export const worksheetFromRows = (
  name: string,
  rows: ReadonlyArray<WorksheetRow>,
  numberRows: ReadonlyArray<number> = [],
): Worksheet =>
  Predicate.isString(name) && areWorksheetRows(rows, numberRows)
    ? trustedWorksheet(name, rows)
    : new Worksheet({ name, columns: [], rows, merges: [] });

/**
 * `ws` with its column definitions and merged ranges set (and its
 * `visibility`, which defaults to its own), for a reader that
 * builds a sheet's rows with {@link worksheetFromRows} and reads its layout
 * apart (the XLSX reader's `<cols>` and `<mergeCells>`). The rows are kept as
 * they are, unchecked again, since a `Worksheet`'s rows are already valid; the
 * columns and merges are taken unchecked when they are `SheetColumn` and
 * `MergeRange` instances, and otherwise checked as `new Worksheet` checks
 * them, failing as it does.
 *
 * @example
 * ```ts
 * import { MergeRange, SheetColumn, withSheetLayout, worksheet } from "@thomasfosterau/effect-document"
 *
 * withSheetLayout(worksheet("S", [["a", "b"]]), [new SheetColumn({ width: 20 })], [
 *   new MergeRange({ fromRow: 0, fromCol: 0, toRow: 0, toCol: 1 }),
 * ])
 * ```
 */
export const withSheetLayout = (
  ws: Worksheet,
  columns: ReadonlyArray<SheetColumn>,
  merges: ReadonlyArray<MergeRange>,
  visibility?: SheetVisibility,
): Worksheet => {
  const shown = visibility ?? ws.visibility;
  return columns.every((c) => c instanceof SheetColumn) &&
    merges.every((m) => m instanceof MergeRange)
    ? trustedWorksheetLayout(ws, columns, merges, shown)
    : new Worksheet(
        Object.assign(
          ws.attr === undefined ? {} : { attr: ws.attr },
          { name: ws.name, columns, rows: ws.rows, merges },
          shown === undefined ? {} : { visibility: shown },
        ),
      );
};

/** Whether rows are what `Worksheet` accepts unchanged (see {@link worksheetFromRows}). */
const areWorksheetRows = (
  rows: ReadonlyArray<WorksheetRow>,
  numberRows: ReadonlyArray<number>,
): boolean => {
  let previous = -1;
  let next = 0;
  // oxlint-disable-next-line effect/imperative-loops -- once per row of a sheet a reader builds, a cursor over `numberRows` beside it
  for (let i = 0; i < rows.length; i++) {
    const listed = numberRows[next] === i;
    if (listed) next++;
    const row = rows[i];
    if (row === undefined) return false;
    previous = acceptedIndex(row, previous, listed);
    if (previous === -1) return false;
  }
  return true;
};

/**
 * The index of a row `Worksheet` accepts unchanged after a row at
 * `previous`, or -1: a plain row of positional cells (of plain numbers when
 * `listed`, by their own loop) is the next index, a `SheetRow` its own when
 * it is later.
 */
const acceptedIndex = (row: WorksheetRow, previous: number, listed: boolean): number => {
  if (isPlainRow(row))
    return (listed && isPositionalNumbers(row)) || isPositional(row) ? previous + 1 : -1;
  return row instanceof SheetRow && row.index > previous ? row.index : -1;
};

/**
 * A worksheet of rows its caller built valid itself, taken without any
 * check: the unchecked escape hatch for a reader's own output, as `trustAs`
 * is for a document's profile. Each row must be what `Worksheet` accepts (a
 * `SheetRow` instance, or a plain row of positional cells: plain cells, cell
 * instances and gaps, the last a cell), the rows in strictly ascending index
 * order. Nothing checks it, so a row that is not breaks the worksheet's
 * guarantees silently: anything not built by the caller goes through
 * {@link worksheetFromRows}, which checks every cell (about 2.3 ms per 100k
 * rows of four, on bench/csv.bench.ts's floats table).
 *
 * @example
 * ```ts
 * import { worksheetOfTrustedRows } from "@thomasfosterau/effect-document"
 *
 * // rows a reader typed itself: plain cells, a row per line
 * worksheetOfTrustedRows("Sheet1", [["a", 1], ["b", 2]])
 * ```
 */
export const worksheetOfTrustedRows = (
  name: string,
  rows: ReadonlyArray<WorksheetRow>,
): Worksheet => trustedWorksheet(name, rows);
