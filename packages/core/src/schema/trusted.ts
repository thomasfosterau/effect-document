/**
 * Construction without the schema pass, for the nodes readers build by the
 * million: spreadsheet cells and rows, and text runs.
 *
 * A `Schema.Class` constructor parses its input against the class's struct
 * every time, and a nested class re-checks every child it is given: a cell is
 * parsed when it is built, and again as a `SheetCell` union member of its
 * row's cells. For a
 * large sheet that is most of a reader's time. Effect builds a decoded class
 * without that pass internally (`makeClassTrusted`), but exports no public way
 * to, so this module does what the class's own constructor does once its
 * struct has accepted the fields: an object on the class's prototype holding
 * the fields as its own enumerable properties, in the struct's field order. An
 * instance built here is `instanceof` the class, `Equal.equals` to one built
 * with `new`, and encodes to the same JSON.
 *
 * Each builder here takes only values its caller has already shown to satisfy
 * the schema (see the guards in `document.ts` and `sheet.ts`); anything else
 * goes through the validating constructor, so an invalid value fails exactly
 * as before.
 *
 * @internal
 */

import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import type * as Types from "effect/Types";
import {
  CellBlank,
  CellBoolean,
  CellDate,
  CellError,
  CellFormula,
  CellNumber,
  CellRichText,
  CellText,
  type SheetCell,
  SheetRow,
  Str,
  Worksheet,
} from "./ast.ts";

/** A text run whose `text` is a string. */
export const trustedStr = (text: string): Str => {
  const node: Types.Mutable<Str> = Object.create(Str.prototype);
  node._tag = "Str";
  node.text = text;
  return node;
};

/** A value built on its first use and shared after: nodes are immutable, so one serves every place. */
const shared = <A>(make: () => A): (() => A) => {
  let value = Option.none<A>();
  return () =>
    Option.getOrElse(value, () => {
      const made = make();
      value = Option.some(made);
      return made;
    });
};

/*
 * Constructor functions for the nodes there is one of per cell (a text or
 * number cell). An object
 * built by `new` gets exactly the slots its constructor stores, where one
 * built by `Object.create` plus stores gets V8's default slack: 40 bytes a
 * node rather than 56, a sixth of a CSV document's memory (and of the time
 * collecting it). Their prototypes are the classes' own, set on first use.
 */
function TextCell(this: { _tag: string; value: string }, value: string): void {
  this._tag = "CellText";
  this.value = value;
}
function NumberCell(this: { _tag: string; value: number }, value: number): void {
  this._tag = "CellNumber";
  this.value = value;
}

interface Constructors {
  readonly text: new (value: string) => CellText;
  readonly number: new (value: number) => CellNumber;
}

const constructors = /*#__PURE__*/ shared((): Constructors => {
  TextCell.prototype = CellText.prototype;
  NumberCell.prototype = CellNumber.prototype;
  // oxlint-disable-next-line effect/no-chained-type-assertions, effect/avoid-any, typescript/no-unsafe-type-assertion, effect/casting-awareness, effect/require-safety-comment-for-type-assertion -- SAFETY: a function with the class's prototype that stores exactly the class's fields builds what the class's constructor builds once its struct has accepted them (see the module comment)
  const text = TextCell as unknown as Constructors["text"];
  // oxlint-disable-next-line effect/no-chained-type-assertions, effect/avoid-any, typescript/no-unsafe-type-assertion, effect/casting-awareness, effect/require-safety-comment-for-type-assertion -- SAFETY: as above
  const number = NumberCell as unknown as Constructors["number"];
  return { text, number };
});

/** A text cell whose `value` is a string. */
export const trustedText = (value: string): CellText => {
  return new (constructors().text)(value);
};

/** A number cell whose `value` is a number (`Schema.Number` accepts every one). */
export const trustedNumber = (value: number): CellNumber => {
  return new (constructors().number)(value);
};

/** A boolean cell whose `value` is a boolean. */
const makeBoolean = (value: boolean): CellBoolean => {
  const c: Types.Mutable<CellBoolean> = Object.create(CellBoolean.prototype);
  c._tag = "CellBoolean";
  c.value = value;
  return c;
};

const sharedTrue = /*#__PURE__*/ shared(() => makeBoolean(true));
const sharedFalse = /*#__PURE__*/ shared(() => makeBoolean(false));

/**
 * An unstyled boolean cell: one shared instance per value, since every
 * `true` cell is the same immutable node (a column of booleans would
 * otherwise allocate one per row).
 */
export const trustedBoolean = (value: boolean): CellBoolean =>
  value ? sharedTrue() : sharedFalse();

/** An unstyled blank cell. */
const sharedBlank = /*#__PURE__*/ shared((): CellBlank => {
  const c: Types.Mutable<CellBlank> = Object.create(CellBlank.prototype);
  c._tag = "CellBlank";
  return c;
});

/** The unstyled blank cell: one shared instance, as every one is the same immutable node. */
export const trustedBlank = (): CellBlank => sharedBlank();

/**
 * Whether a value is an instance of one of the cell classes (not a
 * subclass), so the `SheetCell` union would accept it unchanged. A plain
 * object of the right shape is not: the union converts it, so it takes the
 * validating path, as anything else does.
 */
export const isCellInstance = (value: unknown): value is SheetCell => {
  // the prototype compared directly, not `instanceof` (which walks the whole
  // chain for every class it is not): this runs once per cell a reader builds
  if (!Predicate.isObject(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return (
    proto === CellText.prototype ||
    proto === CellNumber.prototype ||
    proto === CellBlank.prototype ||
    proto === CellBoolean.prototype ||
    proto === CellDate.prototype ||
    proto === CellError.prototype ||
    proto === CellFormula.prototype ||
    proto === CellRichText.prototype
  );
};

/**
 * A row at `index` (a non-negative integer) holding `cells` as its array: cell
 * instances by column, `undefined` for a gap, the last a cell. `height` is
 * kept as an own property even when undefined, as `new SheetRow` keeps it.
 */
export const trustedRowOf = (
  index: number,
  cells: ReadonlyArray<SheetCell | undefined>,
  height?: number,
): SheetRow => {
  const row: Types.Mutable<SheetRow> = Object.create(SheetRow.prototype);
  row.index = index;
  row.cells = cells;
  row.height = height;
  return row;
};

/**
 * A row at `index` (a non-negative integer) of `[column, cell]` entries whose
 * columns are non-negative integers in strictly ascending order, each cell an
 * instance: each cell at its column, every column between a gap. Without a
 * height it has no `height` key, as `sparseRow`'s validating path builds it.
 */
export const trustedSparseRow = (
  index: number,
  entries: ReadonlyArray<readonly [number, SheetCell]>,
  height?: number,
): SheetRow => {
  const row: Types.Mutable<SheetRow> = Object.create(SheetRow.prototype);
  row.index = index;
  row.cells = positional(entries);
  // as `new SheetRow` without a height: no `height` key at all
  if (height !== undefined) row.height = height;
  return row;
};

/**
 * The positional cells of `[column, cell]` entries in strictly ascending
 * column order: an array as long as the last column plus one, `undefined`
 * (never a hole) at each column without an entry.
 */
export const positional = (
  entries: ReadonlyArray<readonly [number, SheetCell]>,
): Array<SheetCell | undefined> => {
  const cells: Array<SheetCell | undefined> = Array.from(
    { length: (entries.at(-1)?.[0] ?? -1) + 1 },
    () => undefined,
  );
  entries.forEach(([col, cell]) => {
    cells[col] = cell;
  });
  return cells;
};

/**
 * An unattributed worksheet with no column specs or merges, whose rows are
 * `SheetRow` instances in strictly ascending index order.
 */
export const trustedWorksheet = (name: string, rows: ReadonlyArray<SheetRow>): Worksheet => {
  const ws: Types.Mutable<Worksheet> = Object.create(Worksheet.prototype);
  ws._tag = "Worksheet";
  ws.name = name;
  ws.columns = [];
  ws.rows = rows;
  ws.merges = [];
  return ws;
};
