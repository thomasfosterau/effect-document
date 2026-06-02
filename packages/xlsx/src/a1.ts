/**
 * A1-notation coordinate helpers for SpreadsheetML cell references.
 *
 * Columns and rows are 0-indexed in code; A1 notation is 1-indexed
 * ("A1" = { col: 0, row: 0 }).
 */

/** Convert a 0-indexed column number to letters: 0 -> "A", 25 -> "Z", 26 -> "AA" */
export const indexToCol = (index: number): string => {
  let result = "";
  let n = index;
  while (n >= 0) {
    result = String.fromCharCode(65 + (n % 26)) + result;
    n = Math.floor(n / 26) - 1;
  }
  return result;
};

/** Convert column letters to a 0-indexed column number: "A" -> 0, "AA" -> 26 */
export const colToIndex = (col: string): number => {
  let result = 0;
  for (const ch of col) {
    result = result * 26 + (ch.charCodeAt(0) - 64);
  }
  return result - 1;
};

export interface CellRef {
  /** 0-indexed column */
  readonly col: number;
  /** 0-indexed row */
  readonly row: number;
}

/** Render a 0-indexed (col, row) pair as an A1 reference: (1, 2) -> "B3" */
export const toA1 = (col: number, row: number): string =>
  `${indexToCol(col)}${row + 1}`;

const A1_PATTERN = /^([A-Z]+)(\d+)$/;

/** Parse an A1 reference into a 0-indexed (col, row) pair, or null if invalid */
export const parseA1 = (ref: string): CellRef | null => {
  const match = A1_PATTERN.exec(ref);
  if (match === null) {
    return null;
  }
  return {
    col: colToIndex(match[1]!),
    row: Number.parseInt(match[2]!, 10) - 1,
  };
};
