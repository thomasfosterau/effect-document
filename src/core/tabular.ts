/**
 * The tabular intermediate representation - the natural target for
 * spreadsheet-like formats (CSV, TSV, XLSX, ...).
 *
 * A Workbook holds one or more Sheets; each Sheet is a grid of typed Cells.
 * Like the document AST, everything is an Effect Schema class so workbooks
 * can be encoded to / decoded from plain JSON.
 */

import { Schema } from "effect";

// ============================================================================
// Cells
// ============================================================================

/** A text cell */
export class CellString extends Schema.TaggedClass<CellString>()("CellString", {
  value: Schema.String,
}) {}

/** A numeric cell */
export class CellNumber extends Schema.TaggedClass<CellNumber>()("CellNumber", {
  value: Schema.Number,
}) {}

/** A boolean cell */
export class CellBoolean extends Schema.TaggedClass<CellBoolean>()(
  "CellBoolean",
  {
    value: Schema.Boolean,
  }
) {}

/** A date cell (encoded as an ISO-8601 string) */
export class CellDate extends Schema.TaggedClass<CellDate>()("CellDate", {
  value: Schema.Date,
}) {}

/** An empty cell */
export class CellNull extends Schema.TaggedClass<CellNull>()("CellNull", {}) {}

/** Any typed cell value */
export type Cell = CellString | CellNumber | CellBoolean | CellDate | CellNull;

export const Cell = Schema.Union(
  CellString,
  CellNumber,
  CellBoolean,
  CellDate,
  CellNull
);

/** Ergonomic cell constructors */
export const cell = {
  str: (value: string): CellString => new CellString({ value }),
  num: (value: number): CellNumber => new CellNumber({ value }),
  bool: (value: boolean): CellBoolean => new CellBoolean({ value }),
  date: (value: Date): CellDate => new CellDate({ value }),
  empty: (): CellNull => new CellNull(),
} as const;

/** Render any cell to its canonical string form */
export const cellToString = (c: Cell): string => {
  switch (c._tag) {
    case "CellString":
      return c.value;
    case "CellNumber":
      return String(c.value);
    case "CellBoolean":
      return c.value ? "true" : "false";
    case "CellDate":
      return c.value.toISOString();
    case "CellNull":
      return "";
  }
};

// ============================================================================
// Sheets & Workbooks
// ============================================================================

/** A single sheet: a named grid of cells with optional column headers */
export class Sheet extends Schema.Class<Sheet>("Sheet")({
  name: Schema.String,
  headers: Schema.NullOr(Schema.Array(Schema.String)),
  rows: Schema.Array(Schema.Array(Cell)),
}) {}

/** A workbook: one or more sheets */
export class Workbook extends Schema.Class<Workbook>("Workbook")({
  sheets: Schema.NonEmptyArray(Sheet),
}) {}

/** Construct a sheet */
export const sheet = (
  name: string,
  rows: ReadonlyArray<ReadonlyArray<Cell>>,
  headers: ReadonlyArray<string> | null = null
): Sheet => new Sheet({ name, headers, rows });

/** Construct a single-sheet workbook */
export const workbookOf = (first: Sheet, ...rest: ReadonlyArray<Sheet>): Workbook =>
  new Workbook({ sheets: [first, ...rest] });
