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
  sheetRowFrom,
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
    const kind = this.typing.kind(raw);
    if (kind === "blank") return cell.blank();
    if (column === "blank") this.kinds[c] = kind;
    else if (kind !== column) this.contradicted = true;
    return typedCell(raw, kind, this.typing);
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
  const end = fastEachRow(text, plan, (fields) => {
    // every row must be as wide as the first, header or not
    if (width === -1) width = fields.length;
    else if (options.checkWidths && fields.length !== width) return false;
    if (hold && Option.isNone(first)) {
      first = Option.some(fields);
      return true;
    }
    rows.push(sheetRowFrom(rows.length + (hold ? 1 : 0), fields, cellAt));
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
      const row = sheetRowFrom(0, fields, cellAt);
      return guess.contradicted ? Option.none() : Option.some([row, ...rows]);
    },
  });
};
