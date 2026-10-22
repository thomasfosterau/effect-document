/**
 * Shared-formula translation for SpreadsheetML.
 *
 * A `<f t="shared" si="N">` group stores its formula text only on the master
 * (top-left) cell; every other cell in the group carries just the `si` index
 * and means "the master's formula, moved by my offset from it". Translating
 * shifts each relative row/column reference by that offset and leaves
 * `$`-anchored parts alone, as Excel does when filling a formula.
 */

import { colToIndex, indexToCol } from "./a1.ts";

/** The largest 0-indexed column (XFD) and row (1048576) in a worksheet. */
const MAX_COL = 16383;
const MAX_ROW = 1048575;

// A reference candidate: a cell ("$A$1"), a column range ("A:$C") or a row
// range ("1:$3"). String literals and quoted sheet names are matched first so
// their contents are skipped.
const TOKEN =
  /"(?:[^"]|"")*"|'(?:[^']|'')*'|(\$?)([A-Z]{1,3})(\$?)(\d+)|(\$?)([A-Z]{1,3}):(\$?)([A-Z]{1,3})|(\$?)(\d+):(\$?)(\d+)/gi;

const isNameChar = (ch: string | undefined): boolean =>
  ch !== undefined && /[A-Za-z0-9_.\\]/.test(ch);

const shiftCol = (absolute: string, letters: string, by: number): string | null => {
  if (absolute === "$") return `$${letters.toUpperCase()}`;
  const col = colToIndex(letters.toUpperCase()) + by;
  return col < 0 || col > MAX_COL ? null : indexToCol(col);
};

const shiftRow = (absolute: string, digits: string, by: number): string | null => {
  if (absolute === "$") return `$${digits}`;
  const row = Number.parseInt(digits, 10) - 1 + by;
  return row < 0 || row > MAX_ROW ? null : String(row + 1);
};

/**
 * Move a formula by `rows` × `cols`: relative references shift, absolute ones
 * stay, and a reference pushed off the sheet becomes `#REF!`.
 */
export const translateFormula = (formula: string, rows: number, cols: number): string => {
  if (rows === 0 && cols === 0) return formula;
  return formula.replace(TOKEN, (match, ...groups) => {
    if (match.startsWith('"') || match.startsWith("'")) return match;
    // SAFETY: TOKEN has 12 capture groups, so `replace` passes the match offset 13th
    const offset = groups[12] as number;
    const before = formula[offset - 1];
    const after = formula[offset + match.length];
    // Part of a longer name, a function call ("LOG10("), a sheet prefix
    // ("Sheet1!") or a table name ("Table1[") rather than a reference.
    if (
      isNameChar(before) ||
      isNameChar(after) ||
      after === "(" ||
      after === "!" ||
      after === "["
    ) {
      return match;
    }

    // SAFETY: the first 12 replacer arguments after the match are TOKEN's capture groups
    const [ca, cl, ra, rd, c1a, c1, c2a, c2, r1a, r1, r2a, r2] = groups as Array<
      string | undefined
    >;
    if (cl !== undefined) {
      if (colToIndex(cl.toUpperCase()) > MAX_COL || Number.parseInt(rd!, 10) - 1 > MAX_ROW) {
        return match;
      }
      const col = shiftCol(ca!, cl, cols);
      const row = shiftRow(ra!, rd!, rows);
      return col === null || row === null ? "#REF!" : `${col}${row}`;
    }
    if (c1 !== undefined) {
      const from = shiftCol(c1a!, c1, cols);
      const to = shiftCol(c2a!, c2!, cols);
      return from === null || to === null ? "#REF!" : `${from}:${to}`;
    }
    const from = shiftRow(r1a!, r1!, rows);
    const to = shiftRow(r2a!, r2!, rows);
    return from === null || to === null ? "#REF!" : `${from}:${to}`;
  });
};
