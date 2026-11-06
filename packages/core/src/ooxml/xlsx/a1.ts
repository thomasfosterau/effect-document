/**
 * A1-notation coordinate helpers for SpreadsheetML cell references.
 *
 * Columns and rows are 0-indexed in code; A1 notation is 1-indexed
 * ("A1" = { col: 0, row: 0 }).
 */

import { Ascii, Compiler, Parser, Token } from "@thomasfosterau/effect-parse";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Result from "effect/Result";

/** Convert a 0-indexed column number to letters: 0 -> "A", 25 -> "Z", 26 -> "AA" */
export const indexToCol = (index: number): string =>
  index < 0 ? "" : indexToCol(Math.floor(index / 26) - 1) + String.fromCharCode(65 + (index % 26));

/** Convert column letters to a 0-indexed column number: "A" -> 0, "AA" -> 26 */
export const colToIndex = (col: string): number =>
  Arr.reduce(Arr.fromIterable(col), 0, (result, ch) => result * 26 + (ch.charCodeAt(0) - 64)) - 1;

/** A cell position, 0-indexed (`A1` is `{ col: 0, row: 0 }`). */
export interface CellRef {
  /** 0-indexed column */
  readonly col: number;
  /** 0-indexed row */
  readonly row: number;
}

/** A cell reference that may pin its column and/or row with `$` ("$A1", "B$2", "$C$3"). */
export interface AbsoluteCellRef extends CellRef {
  readonly colAbsolute: boolean;
  readonly rowAbsolute: boolean;
}

/** A rectangular range between two corner references ("A1:B2"); a lone cell is a 1x1 range. */
export interface CellRange {
  readonly start: AbsoluteCellRef;
  readonly end: AbsoluteCellRef;
}

/** Render a 0-indexed (col, row) pair as an A1 reference: (1, 2) -> "B3" */
export const toA1 = (col: number, row: number): string => `${indexToCol(col)}${row + 1}`;

// ============================================================================
// Grammar
// ============================================================================

const dollar = Parser.map(Parser.opt(Token.literal("$")), Option.isSome);
const columnLetters = Parser.map(
  Token.takeWhile(Token.range("A", "Z"), { min: 1 }),
  colToIndex,
).pipe(Parser.expected("column letters"));
const rowNumber = Parser.map(Ascii.digit1, (digits) => Number.parseInt(digits, 10) - 1).pipe(
  Parser.filter((row) => row >= 0),
  Parser.expected("row number"),
);

/** A plain A1 reference, as in a SpreadsheetML cell's `r` attribute: "B3". */
export const a1Cell: Parser.Parser<CellRef> = Compiler.jit(
  Parser.struct({ col: columnLetters, row: rowNumber }),
);

/** An A1 reference with optional `$` markers: "$B$3". */
export const a1AbsoluteCell: Parser.Parser<AbsoluteCellRef> = Compiler.jit(
  Parser.map(
    Parser.seq(dollar, columnLetters, dollar, rowNumber),
    ([colAbsolute, col, rowAbsolute, row]) => ({ col, row, colAbsolute, rowAbsolute }),
  ),
);

/** An A1 range, "A1:B2", or a single cell. */
export const a1Range: Parser.Parser<CellRange> = Compiler.jit(
  Parser.map(
    Parser.seq(a1AbsoluteCell, Parser.opt(Parser.preceded(Token.literal(":"), a1AbsoluteCell))),
    ([start, end]) => ({ start, end: Option.getOrElse(end, () => start) }),
  ),
);

const parseOrNull = <A>(parser: Parser.Parser<A>, ref: string): A | null =>
  Result.getOrNull(Parser.parse(parser, ref));

/** Parse an A1 reference into a 0-indexed (col, row) pair, or null if invalid */
export const parseA1 = (ref: string): CellRef | null => parseOrNull(a1Cell, ref);

/** Parse an A1 reference that may carry `$` markers, or null if invalid */
export const parseA1Absolute = (ref: string): AbsoluteCellRef | null =>
  parseOrNull(a1AbsoluteCell, ref);

/** Parse an A1 range ("A1:B2", "$A$1:$B$2", or a single cell), or null if invalid */
export const parseA1Range = (ref: string): CellRange | null => parseOrNull(a1Range, ref);
