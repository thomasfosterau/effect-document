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
  type IndexedCell,
  indexedCell,
  type SheetCell,
  type SheetRow,
  sheetRow,
  sheetRowOf,
} from "@thomasfosterau/effect-document";
import { fastEachRow, type FastPlan } from "./fast.ts";

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
}

/** What shapes the fused pass, from the reader's options. */
export interface FusedOptions {
  /** Whether the first row is the header (`first`), data (`data`), or to be sniffed. */
  readonly header: "first" | "data" | "sniff";
  readonly inferTypes: boolean;
  readonly byCell: boolean;
  readonly checkWidths: boolean;
}

/** A value's cell under its column's kind (`kind` is the value's own, not blank). */
const typedCell = (raw: string, kind: ColumnKind, typing: Typing): SheetCell =>
  kind === "number"
    ? cell.number(typing.numberOf(raw))
    : kind === "boolean"
      ? cell.boolean(typing.booleanOf(raw))
      : cell.text(raw);

/** Types rows by column, guessing each column's kind from its first non-null value. */
class ColumnGuess {
  readonly kinds: Array<ColumnKind> = [];
  /** Set once a value contradicts its column's guess: the general path must decide. */
  contradicted = false;

  private readonly typing: Typing;

  constructor(typing: Typing) {
    this.typing = typing;
  }

  /** One value's cell, guessing or keeping its column's kind. */
  cell(raw: string, c: number): SheetCell {
    const column = this.kinds[c] ?? "blank";
    if (column === "text") return this.typing.isNull(raw) ? cell.blank() : cell.text(raw);
    if (column === "number") return this.numberCell(raw);
    const kind = this.typing.kind(raw);
    if (kind === "blank") return cell.blank();
    if (column === "blank") this.kinds[c] = kind;
    else if (kind !== column) this.contradicted = true;
    return typedCell(raw, kind, this.typing);
  }

  /**
   * A value's cell in a column of numbers: its number read in the same scan
   * that finds it is one; anything else non-null contradicts the column (a
   * boolean spelling first, as `kind` decides).
   */
  private numberCell(raw: string): SheetCell {
    const typing = this.typing;
    if (typing.isNull(raw)) return cell.blank();
    const value = typing.isBoolean(raw) ? Number.NaN : typing.numberValue(raw);
    if (!Number.isNaN(value)) return cell.number(value);
    this.contradicted = true;
    return cell.text(raw);
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
 * the column gets the very indexed cell (and cell) it got then. Nodes are
 * immutable, so sharing them is invisible, and columns repeat values
 * (categories, flags, small numbers, dates): each repeat is two objects the
 * document does not hold and the collector does not copy. Looking a fresh
 * string up hashes it, which costs about what a cell does, so a column whose
 * values mostly do not repeat (IDs, free text) turns its dictionary off after
 * its first {@link TRIAL} values.
 */
class ColumnCells {
  // oxlint-disable-next-line effect/avoid-native-object-helpers -- a lookup per value of the file; a `HashMap` hashes through `Equal`, the cost this dictionary exists to beat (bench/csv.bench.ts)
  private readonly known = new Map<string, IndexedCell>();
  private on = true;
  private lookups = 0;
  private hits = 0;
  private readonly col: number;
  private readonly make: (raw: string) => SheetCell;

  constructor(col: number, make: (raw: string) => SheetCell, on: boolean) {
    this.col = col;
    this.make = make;
    this.on = on;
  }

  /** The indexed cell for `raw` in this column. */
  get(raw: string): IndexedCell {
    if (!this.on) return indexedCell(this.col, this.make(raw));
    this.lookups++;
    const shared = this.known.get(raw);
    if (shared !== undefined) {
      this.hits++;
      return shared;
    }
    const made = indexedCell(this.col, this.make(raw));
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
      fields.map((raw, c) => (this.columns[c] ??= this.column(c)).get(raw)),
    );
  }

  private column(c: number): ColumnCells {
    const cellAt = this.cellAt;
    return new ColumnCells(c, (raw) => cellAt(raw, c), this.dictionaries);
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
  // a sniffed header needs the column kinds, which only column typing has
  if (options.header === "sniff" && (!options.inferTypes || options.byCell)) return Option.none();
  const guess = new ColumnGuess(typing);
  const cellAt = !options.inferTypes
    ? (raw: string) => cell.text(raw)
    : options.byCell
      ? typing.cellOf
      : (raw: string, c: number) => guess.cell(raw, c);
  // the first row waits when it may be the header: row 0 is kept for it
  const hold = options.header !== "data";
  let first = Option.none<ReadonlyArray<string>>();
  let width = -1;
  const rows: Array<SheetRow> = [];
  const cells = new RowCells(cellAt, text.length >= DICTIONARY_MIN_TEXT);
  const end = fastEachRow(text, plan, (fields) => {
    // every row must be as wide as the first, header or not
    if (width === -1) width = fields.length;
    else if (options.checkWidths && fields.length !== width) return false;
    if (hold && Option.isNone(first)) {
      first = Option.some(fields);
      return true;
    }
    rows.push(cells.row(rows.length + (hold ? 1 : 0), fields));
    return !guess.contradicted;
  });
  if (end !== "done" || guess.contradicted) return Option.none();
  return Option.match(first, {
    onNone: () => Option.some(rows),
    onSome: (fields) => {
      const isHeader =
        options.header === "first" || sniffed(fields, rows.length, guess.kinds, typing);
      if (isHeader) return Option.some([headerRow(fields), ...rows]);
      // a data row after all: typed under the kinds the others settled
      const row = cells.row(0, fields);
      return guess.contradicted ? Option.none() : Option.some([row, ...rows]);
    },
  });
};
