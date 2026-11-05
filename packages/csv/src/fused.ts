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
import { cell, type PlainRow, type RowCell } from "@thomasfosterau/effect-document";
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
  /** A cell typed on its own (`inference: "cell"`), as {@link asCells} builds it. */
  readonly cellOf: (raw: string) => RowCell;
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

/**
 * Values built as a worksheet row's cells: plain cells (the bare number,
 * boolean or text standing for its unstyled node), a blank as its node, and
 * a number no plain cell holds (not finite) as its node too.
 */
export const asCells: Build<RowCell> = {
  blank: () => cell.blank(),
  number: (value) => (Number.isFinite(value) ? value : cell.number(value)),
  boolean: (value) => value,
  text: (raw) => raw,
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

/** The first row as a header, its values as (plain) text cells. */
const headerRow = (fields: ReadonlyArray<string>): PlainRow => fields.slice();

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
  scan: (onRow: (fields: Array<F>, numbers: boolean) => boolean) => FastScanEnd,
  options: FusedOptions,
  guess: ColumnGuess<unknown>,
  rowOf: (index: number, fields: Array<F>, numbers: boolean) => R,
  onFirst: () => void = () => {},
): Option.Option<Pass<F, R>> => {
  // the first row waits when it may be the header: row 0 is kept for it
  const hold = options.header !== "data";
  let first = Option.none<ReadonlyArray<F>>();
  let width = -1;
  const rows: Array<R> = [];
  if (!hold) onFirst();
  const end = scan((fields, numbers) => {
    // every row must be as wide as the first, header or not
    if (width === -1) width = fields.length;
    else if (options.checkWidths && fields.length !== width) return false;
    if (hold && Option.isNone(first)) {
      first = Option.some(fields);
      onFirst();
      return true;
    }
    rows.push(rowOf(rows.length + (hold ? 1 : 0), fields, numbers));
    return !guess.contradicted;
  });
  return end !== "done" || guess.contradicted ? Option.none() : Option.some({ first, rows });
};

/**
 * `rows` with `first` put before them, in place: a pass's rows are its own,
 * and a spread would copy the whole array (a tenth of what `read` allocates
 * on bench/csv.bench.ts's floats table).
 */
const withFirst = <R>(first: R, rows: Array<R>): Array<R> => {
  rows.unshift(first);
  return rows;
};

/** Whether a fused pass can read under these options: a sniffed header needs column kinds. */
const fusable = (options: FusedOptions): boolean =>
  options.header !== "sniff" || (options.inferTypes && !options.byCell);

/**
 * A worksheet's rows as the one-pass read builds them: plain rows (#227),
 * each the scanner's own array of the row's cells, and the positions
 * (ascending) of those that are arrays of doubles, for `worksheetFromRows`
 * to check without boxing their numbers.
 */
export interface FusedSheet {
  readonly rows: ReadonlyArray<PlainRow>;
  readonly numberRows: ReadonlyArray<number>;
}

/**
 * The worksheet's rows from `text` in one pass, or none when the general path
 * must read it (see the module comment).
 */
export const fusedRows = (
  text: string,
  plan: FastPlan,
  options: FusedOptions,
  typing: Typing,
): Option.Option<FusedSheet> => {
  if (!fusable(options)) return Option.none();
  const guess = new ColumnGuess(typing, asCells);
  const cellAt: (raw: string, c: number) => RowCell = !options.inferTypes
    ? (raw) => raw
    : options.byCell
      ? typing.cellOf
      : (raw, c) => guess.value(raw, c);
  // a number read in place is a plain decimal, so finite: a plain cell
  const reader = new TypedReader<RowCell>(
    guess.kinds,
    cellAt,
    typing.numberAt,
    options.inferTypes && !options.byCell,
    undefined,
    asCells.number,
  );
  // a row's index is its position in the finished rows (the held first row,
  // header or not, is position 0)
  const numberRows: Array<number> = [];
  return Option.flatMap(
    fusedPass<RowCell, PlainRow>(
      (onRow) => fastEachRecord(text, plan, reader, onRow),
      options,
      guess,
      (index, fields, numbers) => {
        if (numbers) numberRows.push(index);
        return fields;
      },
      () => reader.start(),
    ),
    ({ first, rows }) =>
      Option.match(first, {
        onNone: () => Option.some({ rows, numberRows }),
        onSome: () => {
          const fields = reader.held;
          const isHeader =
            options.header === "first" || sniffed(fields, rows.length, guess.kinds, typing);
          if (isHeader)
            return Option.some({ rows: withFirst(headerRow(fields), rows), numberRows });
          // a data row after all: typed under the kinds the others settled
          const row = fields.map(cellAt);
          return guess.contradicted
            ? Option.none()
            : Option.some({ rows: withFirst(row, rows), numberRows });
        },
      }),
  );
};

/**
 * A scan's fields, built as they are scanned once {@link start} is called:
 * each by `field`, except that a field of a column guessed to hold numbers
 * is read from the text in place (no string is made for it). Before that,
 * the first row (which may be the header) is kept as strings in
 * {@link held}, its fields placeholders.
 */
class TypedReader<A> implements FieldReader<A> {
  /** The first row's strings, until {@link start}. */
  readonly held: Array<string> = [];
  /** A placeholder for a field not yet built. */
  readonly fill: A;
  private typing = false;
  private readonly kinds: ReadonlyArray<ColumnKind>;
  private readonly field: (raw: string, c: number) => A;
  private readonly numberAt: (text: string, start: number, end: number) => number;
  private readonly byColumn: boolean;

  /** A number read in place, as a field. */
  private readonly asNumber: (value: number) => A;

  constructor(
    kinds: ReadonlyArray<ColumnKind>,
    field: (raw: string, c: number) => A,
    numberAt: (text: string, start: number, end: number) => number,
    byColumn: boolean,
    fill: A,
    asNumber: (value: number) => A,
  ) {
    this.fill = fill;
    this.asNumber = asNumber;
    this.kinds = kinds;
    this.field = field;
    this.numberAt = numberAt;
    this.byColumn = byColumn;
  }

  /** Build every field from here on. */
  start(): void {
    this.typing = true;
  }

  readonly inPlace = true;

  unquoted(text: string, start: number, end: number, c: number): A {
    if (this.typing && this.byColumn && this.kinds[c] === "number") {
      const value = this.numberAt(text, start, end);
      if (!Number.isNaN(value)) return this.asNumber(value);
    }
    return this.quoted(text.slice(start, end), c);
  }

  quoted(value: string, c: number): A {
    if (this.typing) return this.field(value, c);
    this.held[c] = value;
    return this.fill;
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
  const reader = new TypedReader<FusedValue>(
    guess.kinds,
    typed,
    typing.numberAt,
    options.inferTypes && !options.byCell,
    null,
    asValues.number,
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
            : Option.some({ headers: null, rows: withFirst(row, rows) });
        },
      }),
  );
};
