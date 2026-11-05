/**
 * The CSV reader's fast path: scan and type in one pass.
 *
 * The reader's general path scans the whole text into rows of strings,
 * finds each column's type over all of them, then builds the cells. Every
 * row's strings stay alive until the end, and a garbage collector copies
 * everything alive. When the fast scanner applies (`fast.ts`) and no option
 * needs the whole table first (`providedHeaders`, `validateHeaders`), this
 * module builds each worksheet row as soon as the scanner reads it instead,
 * typing its values by a guess at each column's type: the type of the
 * column's first non-null value, text absorbing anything. The guess is
 * exactly the general path's answer unless a later value contradicts it (a
 * text or boolean value in a column of numbers, say): then, or on anything
 * else the general path must judge (a short or long row when widths are
 * checked, an unclosed quote), this path gives up and the general path runs
 * from the start. So its result, and every error, is the general path's.
 *
 * @internal
 */

import * as Option from "effect/Option";
import {
  cell,
  type SheetCell,
  type SheetRow,
  sheetRow,
  sheetRowOf,
} from "@thomasfosterau/effect-document";
import { fastEachRecord, type FastPlan, type FastScanEnd, type FieldReader } from "./fast.ts";

/** A column's type so far: `blank` while it holds only blanks. */
export type ColumnKind = "number" | "boolean" | "text" | "blank";

/** How values are typed: the reader's classifier, as the fused pass uses it. */
export interface Typing {
  /** A value's kind (`blank` for a null spelling), without building its value. */
  readonly kind: (raw: string) => ColumnKind;
  readonly isNull: (raw: string) => boolean;
  /** The boolean a value of kind `boolean` spells. */
  readonly booleanOf: (raw: string) => boolean;
  /** The number a value of kind `number` spells. */
  readonly numberOf: (raw: string) => number;
  /** The number a value spells, or `NaN` if it spells none. */
  readonly numberValue: (raw: string) => number;
  /** Whether a value spells a boolean. */
  readonly isBoolean: (raw: string) => boolean;
  /** A cell typed on its own (`inference: "cell"`). */
  readonly cellOf: (raw: string) => SheetCell;
  /** A value typed on its own (`inference: "cell"`): the value of its `cellOf` cell. */
  readonly valueOf: (raw: string) => FusedValue;
  /**
   * The number the text from `start` to `end` spells, read from the text in
   * place, when it is one that a column of numbers takes as one (neither a
   * null nor a boolean spelling), or `NaN` when the slice must be judged as
   * a string.
   */
  readonly numberAt: (text: string, start: number, end: number) => number;
}

/** What shapes the fused pass, from the reader's options. */
export interface FusedOptions {
  /** Whether the first row is the header (`first`), data (`data`), or to be sniffed. */
  readonly header: "first" | "data" | "sniff";
  readonly inferTypes: boolean;
  readonly byCell: boolean;
  readonly checkWidths: boolean;
}

/** How a guessed column's values are built: as cells, or as plain values. */
export interface Build<A> {
  readonly blank: () => A;
  readonly number: (value: number) => A;
  readonly boolean: (value: boolean) => A;
  readonly text: (raw: string) => A;
}

/** Values built as worksheet cells. */
export const asCells: Build<SheetCell> = {
  blank: () => cell.blank(),
  number: (value) => cell.number(value),
  boolean: (value) => cell.boolean(value),
  text: (raw) => cell.text(raw),
};

/** A typed CSV value: `null` for a null spelling. */
export type FusedValue = string | number | boolean | null;

/** Values built as plain values. */
export const asValues: Build<FusedValue> = {
  blank: () => null,
  number: (value) => value,
  boolean: (value) => value,
  text: (raw) => raw,
};

/** Types rows by column, guessing each column's kind from its first non-null value. */
class ColumnGuess<A> {
  readonly kinds: Array<ColumnKind> = [];
  /** Set once a value contradicts its column's guess: the general path must decide. */
  contradicted = false;

  private readonly typing: Typing;
  private readonly build: Build<A>;

  constructor(typing: Typing, build: Build<A>) {
    this.typing = typing;
    this.build = build;
  }

  /** One value, guessing or keeping its column's kind. */
  value(raw: string, c: number): A {
    const { build, typing } = this;
    const column = this.kinds[c] ?? "blank";
    if (column === "text") return typing.isNull(raw) ? build.blank() : build.text(raw);
    if (column === "number") return this.numberValue(raw);
    const kind = typing.kind(raw);
    if (kind === "blank") return build.blank();
    if (column === "blank") this.kinds[c] = kind;
    else if (kind !== column) this.contradicted = true;
    return kind === "number"
      ? build.number(typing.numberOf(raw))
      : kind === "boolean"
        ? build.boolean(typing.booleanOf(raw))
        : build.text(raw);
  }

  /**
   * A value in a column of numbers: its number read in the same scan that
   * finds it is one; anything else non-null contradicts the column (a
   * boolean spelling first, as `kind` decides).
   */
  private numberValue(raw: string): A {
    const { build, typing } = this;
    if (typing.isNull(raw)) return build.blank();
    const value = typing.isBoolean(raw) ? Number.NaN : typing.numberValue(raw);
    if (!Number.isNaN(value)) return build.number(value);
    this.contradicted = true;
    return build.text(raw);
  }
}

/** Values a column's dictionary is first judged after. */
const TRIAL = 256;
/**
 * The smallest text that dictionaries are used for: below it the document is
 * small enough that the collector's copying costs less than the lookups.
 */
const DICTIONARY_MIN_TEXT = 256 * 1024;
/** The most values a column's dictionary holds. */
const MAX_VALUES = 8192;

/**
 * One column's cells, as a dictionary of its values: a value seen before in
 * the column gets the very cell it got then. Nodes are immutable, so sharing
 * them is invisible, and columns repeat values (categories, flags, small
 * numbers, dates): each repeat is an object the document does not hold and
 * the collector does not copy. Looking a fresh
 * string up hashes it, which costs about what a cell does, so a column whose
 * values mostly do not repeat (IDs, free text) turns its dictionary off after
 * its first {@link TRIAL} values.
 */
class ColumnCells {
  // oxlint-disable-next-line effect/avoid-native-object-helpers -- a lookup per value of the file; a `HashMap` hashes through `Equal`, the cost this dictionary exists to beat (bench/csv.bench.ts)
  private readonly known = new Map<string, SheetCell>();
  private on = true;
  private lookups = 0;
  private hits = 0;
  private readonly make: (raw: string) => SheetCell;

  constructor(make: (raw: string) => SheetCell, on: boolean) {
    this.make = make;
    this.on = on;
  }

  /** Whether the dictionary is still on: off, a value's cell depends on its value alone. */
  get active(): boolean {
    return this.on;
  }

  /** The cell for `raw` in this column. */
  get(raw: string): SheetCell {
    if (!this.on) return this.make(raw);
    this.lookups++;
    const shared = this.known.get(raw);
    if (shared !== undefined) {
      this.hits++;
      return shared;
    }
    const made = this.make(raw);
    if (this.lookups >= TRIAL && this.hits * 2 < this.lookups) {
      // mostly distinct values: the lookups cost more than they save
      this.on = false;
      this.known.clear();
    } else if (this.known.size < MAX_VALUES) this.known.set(raw, made);
    return made;
  }
}

/** Each column's {@link ColumnCells}, made as rows reach it. */
class RowCells {
  private readonly columns: Array<ColumnCells> = [];
  private readonly cellAt: (raw: string, col: number) => SheetCell;
  private readonly dictionaries: boolean;

  constructor(cellAt: (raw: string, col: number) => SheetCell, dictionaries: boolean) {
    this.cellAt = cellAt;
    this.dictionaries = dictionaries;
  }

  /** The row at `index` of these values. */
  row(index: number, fields: ReadonlyArray<string>): SheetRow {
    return sheetRowOf(
      index,
      fields.map((raw, c) => this.at(raw, c)),
    );
  }

  /** The cell for `raw` in column `c`. */
  at(raw: string, c: number): SheetCell {
    return (this.columns[c] ??= this.column(c)).get(raw);
  }

  /**
   * Whether column `c`'s cells depend on their values alone (its dictionary
   * is off, or there are none), so a cell may be built without its string.
   */
  unshared(c: number): boolean {
    const column = this.columns[c];
    return column !== undefined && !column.active;
  }

  private column(c: number): ColumnCells {
    const cellAt = this.cellAt;
    return new ColumnCells((raw) => cellAt(raw, c), this.dictionaries);
  }
}

/** The first row as a header, its values as text cells. */
const headerRow = (fields: ReadonlyArray<string>): SheetRow =>
  sheetRow(
    0,
    fields.map((h) => cell.text(h)),
  );

/**
 * Whether the held first row is the header, as the general path sniffs it:
 * at least one other row, every first-row value non-empty text, and some
 * column of its whose other values are all numbers or all booleans.
 */
const sniffed = (
  first: ReadonlyArray<string>,
  others: number,
  kinds: ReadonlyArray<ColumnKind>,
  typing: Typing,
): boolean =>
  others > 0 &&
  first.every((raw) => raw.trim() !== "" && typing.kind(raw) === "text") &&
  first.some((_, c) => kinds[c] === "number" || kinds[c] === "boolean");

/** What one fused pass read: the held first row, if any, and the other rows built. */
interface Pass<F, R> {
  readonly first: Option.Option<ReadonlyArray<F>>;
  readonly rows: Array<R>;
}

/**
 * Scan `text`, building each row with `rowOf` as it is read (the first held
 * back raw when it may be the header), or none when the general path must
 * read it: a quote unclosed, a row's width off while widths are checked, or
 * a value contradicting its column's guess.
 */
const fusedPass = <F, R>(
  scan: (onRow: (fields: Array<F>) => boolean) => FastScanEnd,
  options: FusedOptions,
  guess: ColumnGuess<unknown>,
  rowOf: (index: number, fields: Array<F>) => R,
  onFirst: () => void = () => {},
): Option.Option<Pass<F, R>> => {
  // the first row waits when it may be the header: row 0 is kept for it
  const hold = options.header !== "data";
  let first = Option.none<ReadonlyArray<F>>();
  let width = -1;
  const rows: Array<R> = [];
  if (!hold) onFirst();
  const end = scan((fields) => {
    // every row must be as wide as the first, header or not
    if (width === -1) width = fields.length;
    else if (options.checkWidths && fields.length !== width) return false;
    if (hold && Option.isNone(first)) {
      first = Option.some(fields);
      onFirst();
      return true;
    }
    rows.push(rowOf(rows.length + (hold ? 1 : 0), fields));
    return !guess.contradicted;
  });
  return end !== "done" || guess.contradicted ? Option.none() : Option.some({ first, rows });
};

/** Whether a fused pass can read under these options: a sniffed header needs column kinds. */
const fusable = (options: FusedOptions): boolean =>
  options.header !== "sniff" || (options.inferTypes && !options.byCell);

/**
 * The worksheet's rows from `text` in one pass, or none when the general path
 * must read it (see the module comment).
 */
export const fusedRows = (
  text: string,
  plan: FastPlan,
  options: FusedOptions,
  typing: Typing,
): Option.Option<ReadonlyArray<SheetRow>> => {
  if (!fusable(options)) return Option.none();
  const guess = new ColumnGuess(typing, asCells);
  const cellAt = !options.inferTypes
    ? (raw: string) => cell.text(raw)
    : options.byCell
      ? typing.cellOf
      : (raw: string, c: number) => guess.value(raw, c);
  const cells = new RowCells(cellAt, text.length >= DICTIONARY_MIN_TEXT);
  const reader = new CellReader(
    guess.kinds,
    cells,
    typing.numberAt,
    options.inferTypes && !options.byCell,
  );
  return Option.flatMap(
    fusedPass<SheetCell, SheetRow>(
      (onRow) => fastEachRecord(text, plan, reader, onRow),
      options,
      guess,
      (index, fields) => sheetRowOf(index, fields),
      () => reader.start(),
    ),
    ({ first, rows }) =>
      Option.match(first, {
        onNone: () => Option.some(rows),
        onSome: () => {
          const fields = reader.held;
          const isHeader =
            options.header === "first" || sniffed(fields, rows.length, guess.kinds, typing);
          if (isHeader) return Option.some([headerRow(fields), ...rows]);
          // a data row after all: typed under the kinds the others settled
          const row = cells.row(0, fields);
          return guess.contradicted ? Option.none() : Option.some([row, ...rows]);
        },
      }),
  );
};

/**
 * A scan's fields, built as they are scanned once {@link start} is called.
 * Before that, the first row (which may be the header) is kept as strings
 * in {@link held}, its fields placeholders. A field of a column guessed to
 * hold numbers is read from the text in place when {@link inPlace} allows:
 * no string is made for it.
 */
abstract class FieldBuilder<A> implements FieldReader<A> {
  /** The first row's strings, until {@link start}. */
  readonly held: Array<string> = [];
  /** A placeholder for a field not yet built. */
  abstract readonly fill: A;
  private typing = false;
  private readonly kinds: ReadonlyArray<ColumnKind>;
  private readonly numberAt: (text: string, start: number, end: number) => number;
  private readonly byColumn: boolean;

  constructor(
    kinds: ReadonlyArray<ColumnKind>,
    numberAt: (text: string, start: number, end: number) => number,
    byColumn: boolean,
  ) {
    this.kinds = kinds;
    this.numberAt = numberAt;
    this.byColumn = byColumn;
  }

  /** Build every field from here on. */
  start(): void {
    this.typing = true;
  }

  readonly unquoted = (text: string, start: number, end: number, c: number): A => {
    if (this.typing && this.byColumn && this.kinds[c] === "number" && this.inPlace(c)) {
      const value = this.numberAt(text, start, end);
      if (!Number.isNaN(value)) return this.number(value, c);
    }
    return this.quoted(text.slice(start, end), c);
  };

  readonly quoted = (value: string, c: number): A => {
    if (this.typing) return this.field(value, c);
    this.held[c] = value;
    return this.fill;
  };

  /** Whether column `c`'s numbers may be read in place. */
  protected abstract inPlace(c: number): boolean;
  /** The field for a number read in place in column `c`. */
  protected abstract number(value: number, c: number): A;
  /** The field for `raw` in column `c`. */
  protected abstract field(raw: string, c: number): A;
}

/**
 * The document scan's fields: cells, a number read in place only in
 * a column whose dictionary is off (its values mostly unique).
 */
class CellReader extends FieldBuilder<SheetCell> {
  readonly fill: SheetCell = cell.blank();
  private readonly cells: RowCells;

  constructor(
    kinds: ReadonlyArray<ColumnKind>,
    cells: RowCells,
    numberAt: (text: string, start: number, end: number) => number,
    byColumn: boolean,
  ) {
    super(kinds, numberAt, byColumn);
    this.cells = cells;
  }

  protected inPlace(c: number): boolean {
    return this.cells.unshared(c);
  }

  protected number(value: number): SheetCell {
    return cell.number(value);
  }

  protected field(raw: string, c: number): SheetCell {
    return this.cells.at(raw, c);
  }
}

/** The typed scan's fields: plain values. */
class ValueReader extends FieldBuilder<FusedValue> {
  readonly fill: FusedValue = null;
  private readonly typed: (raw: string, c: number) => FusedValue;

  constructor(
    kinds: ReadonlyArray<ColumnKind>,
    typed: (raw: string, c: number) => FusedValue,
    numberAt: (text: string, start: number, end: number) => number,
    byColumn: boolean,
  ) {
    super(kinds, numberAt, byColumn);
    this.typed = typed;
  }

  protected inPlace(): boolean {
    return true;
  }

  protected number(value: number): FusedValue {
    return value;
  }

  protected field(raw: string, c: number): FusedValue {
    return this.typed(raw, c);
  }
}

/** A table of typed values: its header (or `null`) and its rows. */
export interface FusedTable {
  readonly headers: ReadonlyArray<string> | null;
  readonly rows: ReadonlyArray<ReadonlyArray<FusedValue>>;
}

/**
 * The typed values of `text` in one pass, as `fusedRows` reads its cells
 * (each value is the cell's), or none when the general path must read it.
 * Each row is typed in the array the scanner read it into.
 */
export const fusedValues = (
  text: string,
  plan: FastPlan,
  options: FusedOptions,
  typing: Typing,
): Option.Option<FusedTable> => {
  if (!fusable(options)) return Option.none();
  const guess = new ColumnGuess(typing, asValues);
  const typed: (raw: string, c: number) => FusedValue = !options.inferTypes
    ? (raw) => raw
    : options.byCell
      ? typing.valueOf
      : (raw, c) => guess.value(raw, c);
  const reader = new ValueReader(
    guess.kinds,
    typed,
    typing.numberAt,
    options.inferTypes && !options.byCell,
  );
  const typeRow = (fields: ReadonlyArray<string>): Array<FusedValue> =>
    fields.map((raw, c) => typed(raw, c));
  return Option.flatMap(
    fusedPass<FusedValue, ReadonlyArray<FusedValue>>(
      (onRow) => fastEachRecord(text, plan, reader, onRow),
      options,
      guess,
      (_, fields) => fields,
      () => reader.start(),
    ),
    ({ first, rows }) =>
      Option.match(first, {
        onNone: () => Option.some({ headers: null, rows }),
        onSome: () => {
          const strings = reader.held;
          const isHeader =
            options.header === "first" || sniffed(strings, rows.length, guess.kinds, typing);
          if (isHeader) return Option.some({ headers: strings, rows });
          const row = typeRow(strings);
          return guess.contradicted
            ? Option.none()
            : Option.some({ headers: null, rows: [row, ...rows] });
        },
      }),
  );
};
