/**
 * A worksheet's `sheetData` read straight into rows, with no element tree:
 * the XLSX reader's fast path for the bulk of a large part.
 *
 * It reads the markup writers emit for values: `<row>`s of `<c>`s holding a
 * `<v>`, or an `<is>` of plain `<t>`s, with plain names and attributes (the
 * markup the XML layer's fast content scanner reads). At anything else (a
 * formula, rich or prefixed text, an unknown element, a comment, a
 * duplicated attribute, a sheet over its budget) it gives up, and the reader
 * builds the tree and reads it as before, so the rows (and every error) are
 * the tree path's. Cells are positioned and typed exactly as the tree path
 * does (`cellOfText`, `parseA1`, the steps in `rows.ts`); the differential
 * test in `test/xlsx/sheetData.test.ts` holds it to that.
 */

import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import type { PlainCell, SheetCell } from "../../index.ts";
import { parseA1 } from "./a1.ts";
import { cellOfText, decodeXstring } from "./cellText.ts";
import { type ScannedContent, unescapeXml } from "../shared/xml.ts";
import {
  place,
  plainOrCell,
  type RowCellsSoFar,
  rowsInOrder,
  widen,
  type WorksheetRows,
} from "./rows.ts";

const GT = 62;
const SLASH = 47;
const EQ = 61;
const DQUOTE = 34;
const SQUOTE = 39;
const AMP = 38;

/** No index: an attribute absent, or a scan that gave up. */
const NONE = -1;

/** The value of a blank cell, which no row keeps. */
const BLANK: unique symbol = /*#__PURE__*/ Symbol("blank");

/** The row no cell has gone into yet. */
const NO_ROW: RowCellsSoFar = { cells: [] };

const isNameCode = (c: number): boolean =>
  (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57);

const isSpaceCode = (c: number): boolean => c === 32 || c === 9 || c === 10 || c === 13;

/**
 * The scan's state: where it is, the attribute values of the tag just read,
 * and the rows so far. One per scan, so the per-cell steps allocate nothing
 * of their own.
 */
interface Scan {
  readonly xml: string;
  readonly sharedStrings: ReadonlyArray<string>;
  readonly maxCells: number;
  /** The index the scan has reached. */
  p: number;
  /** Whether the tag just read was empty (`/>`). */
  empty: boolean;
  /** The value of the tag's `r` attribute (start and end), or `NONE`. */
  rStart: number;
  rEnd: number;
  /** The value of the tag's `t` attribute (start and end), or `NONE`. */
  tStart: number;
  tEnd: number;
  /** The names of the tag's attributes so far (start, end pairs), to refuse a duplicate. */
  readonly names: Array<number>;
  readonly rows: Map<number, RowCellsSoFar>;
  /** The row the last cell went into, and its index: most cells follow one in the same row. */
  last: RowCellsSoFar;
  lastIndex: number;
  cells: number;
}

/** The end of the plain name at `p` (a letter, then letters and digits), or `NONE`. */
const nameEnd = (xml: string, p: number): number => {
  const c = xml.charCodeAt(p);
  if (!((c >= 97 && c <= 122) || (c >= 65 && c <= 90))) return NONE;
  let j = p + 1;
  // oxlint-disable-next-line effect/imperative-loops -- a character scan, once per tag of a large part (bench/xlsx.bench.ts)
  while (isNameCode(xml.charCodeAt(j))) j++;
  return j;
};

/** Whether `xml` from `start` to `end` is exactly `name`. */
const isName = (xml: string, start: number, end: number, name: string): boolean =>
  end - start === name.length && xml.startsWith(name, start);

/** Whether the name from `start` to `end` was already given in this tag. */
const isDuplicate = (scan: Scan, start: number, end: number): boolean => {
  const { names, xml } = scan;
  const length = end - start;
  // oxlint-disable-next-line effect/imperative-loops -- over a tag's few attributes, once per tag of a large part
  for (let i = 0; i < names.length; i += 2) {
    const from = names[i] ?? 0;
    if ((names[i + 1] ?? 0) - from !== length) continue;
    let same = true;
    // oxlint-disable-next-line effect/imperative-loops -- a character comparison, without slicing either name
    for (let k = 0; k < length && same; k++)
      same = xml.charCodeAt(from + k) === xml.charCodeAt(start + k);
    if (same) return true;
  }
  return false;
};

/**
 * Read the attributes of the start tag whose name ends at `p`, keeping where
 * `r` and `t` are (`scan.rStart` …), and set `scan.p` past the tag: false for
 * anything the XML layer's fast scanner leaves to the parser (a prefixed or
 * unusual name, `xmlns`, spaces around `=`, a duplicate, an entity in `r` or
 * `t`, which the scan would have to decode).
 */
const startTag = (scan: Scan, p: number): boolean => {
  const { xml } = scan;
  scan.rStart = scan.rEnd = scan.tStart = scan.tEnd = NONE;
  scan.names.length = 0;
  let j = p;
  // oxlint-disable-next-line effect/imperative-loops -- once per attribute of a tag of a large part
  for (;;) {
    const spaced = j;
    // oxlint-disable-next-line effect/imperative-loops -- a character scan over whitespace
    while (isSpaceCode(xml.charCodeAt(j))) j++;
    const c = xml.charCodeAt(j);
    if (c === GT) {
      scan.empty = false;
      scan.p = j + 1;
      return true;
    }
    if (c === SLASH) {
      scan.empty = true;
      scan.p = j + 2;
      return xml.charCodeAt(j + 1) === GT;
    }
    if (j === spaced) return false;
    const end = nameEnd(xml, j);
    const quote = xml.charCodeAt(end + 1);
    if (end === NONE || xml.charCodeAt(end) !== EQ || (quote !== DQUOTE && quote !== SQUOTE))
      return false;
    const close = xml.indexOf(quote === DQUOTE ? '"' : "'", end + 2);
    if (close === NONE || isName(xml, j, end, "xmlns") || isDuplicate(scan, j, end)) return false;
    scan.names.push(j, end);
    const isR = isName(xml, j, end, "r");
    if (isR || isName(xml, j, end, "t")) {
      if (hasEntity(xml, end + 2, close)) return false;
      if (isR) {
        scan.rStart = end + 2;
        scan.rEnd = close;
      } else {
        scan.tStart = end + 2;
        scan.tEnd = close;
      }
    }
    j = close + 1;
  }
};

/**
 * At `scan.p`, after any text, the start tag `<name`: true with its
 * attributes read (see {@link startTag}), false at anything else.
 */
const openTag = (scan: Scan, name: string): boolean => {
  const { xml } = scan;
  const lt = xml.indexOf("<", scan.p);
  const end = lt === NONE ? NONE : nameEnd(xml, lt + 1);
  return end !== NONE && isName(xml, lt + 1, end, name) && startTag(scan, end);
};

/** Whether `scan.p`, after any text, is at the closing tag `</name>`; if so, `scan.p` moves past it. */
const closeTag = (scan: Scan, name: string): boolean => {
  const { xml } = scan;
  const lt = xml.indexOf("<", scan.p);
  if (
    lt === NONE ||
    xml.charCodeAt(lt + 1) !== SLASH ||
    !xml.startsWith(name, lt + 2) ||
    xml.charCodeAt(lt + 2 + name.length) !== GT
  )
    return false;
  scan.p = lt + 3 + name.length;
  return true;
};

/** Whether the text from `start` to `end` holds an entity (an `&`). */
const hasEntity = (xml: string, start: number, end: number): boolean => {
  // oxlint-disable-next-line effect/imperative-loops -- a character scan over one value (an indexOf could run on past it, to the end of the part)
  for (let i = start; i < end; i++) if (xml.charCodeAt(i) === AMP) return true;
  return false;
};

/** The text from `start` to `end`, its entities decoded. */
const textOf = (xml: string, start: number, end: number): string => {
  const raw = xml.slice(start, end);
  return hasEntity(xml, start, end) ? unescapeXml(raw) : raw;
};

/** The digits from `start` to `end` as a number, or -1 when there are none, others, or too many to be exact. */
const digitsValue = (xml: string, start: number, end: number): number => {
  if (end <= start || end - start > 15) return -1;
  let n = 0;
  // oxlint-disable-next-line effect/imperative-loops -- a character scan, once per cell of a large part
  for (let i = start; i < end; i++) {
    const d = xml.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return -1;
    n = n * 10 + d;
  }
  return n;
};

/**
 * The 0-indexed column and row of the A1 reference from `start` to `end`
 * (`scan.p` is not moved): column letters then row digits, the way `parseA1`
 * reads them, which it is asked for anything else. `-1` for the row when the
 * reference is not one.
 */
const refColumn = { col: 0, row: 0 };
const readRef = (xml: string, start: number, end: number): typeof refColumn => {
  refColumn.row = -1;
  if (start === NONE) return refColumn;
  let col = 0;
  let i = start;
  // oxlint-disable-next-line effect/imperative-loops -- a character scan, once per cell of a large part
  for (; i < end && i - start < 4; i++) {
    const c = xml.charCodeAt(i);
    if (c < 65 || c > 90) break;
    col = col * 26 + (c - 64);
  }
  const row = digitsValue(xml, i, end);
  if (i > start && row > 0) {
    refColumn.col = col - 1;
    refColumn.row = row - 1;
    return refColumn;
  }
  const parsed = parseA1(xml.slice(start, end));
  refColumn.col = parsed === null ? -1 : parsed.col;
  refColumn.row = parsed === null ? -1 : parsed.row;
  return refColumn;
};

/** The typed value the cell's type (`t`), `<v>` and `<is>` text give, or `BLANK`. */
const valueOf = (
  scan: Scan,
  vStart: number,
  vEnd: number,
  inline: Option.Option<string>,
): SheetCell | PlainCell | typeof BLANK => {
  const { xml } = scan;
  const typed = scan.tStart !== NONE;
  // the two types nearly every cell is: a number (no `t`) and a shared string
  if (!typed || isName(xml, scan.tStart, scan.tEnd, "n")) {
    if (vStart === NONE) return BLANK;
    const text = textOf(xml, vStart, vEnd);
    const n = Number(text);
    // as `numberCell`: blank when all space (which `Number` reads as 0), the
    // text when not a finite number
    return Number.isFinite(n) ? (n === 0 && text.trim() === "" ? BLANK : n) : text;
  }
  if (isName(xml, scan.tStart, scan.tEnd, "s")) {
    if (vStart === NONE) return BLANK;
    const index = digitsValue(xml, vStart, vEnd);
    return (
      scan.sharedStrings[index === -1 ? Number.parseInt(textOf(xml, vStart, vEnd), 10) : index] ??
      BLANK
    );
  }
  const c = cellOfText(
    xml.slice(scan.tStart, scan.tEnd),
    vStart === NONE ? Option.none() : Option.some(textOf(xml, vStart, vEnd)),
    inline,
    scan.sharedStrings,
  );
  return Predicate.isTagged(c, "CellBlank") ? BLANK : plainOrCell(c);
};

/**
 * The text of an `<is>` whose start tag was just read: its `<t>`s'
 * concatenated, as `collectText` gives it, or none at anything but
 * plain `<t>`s (a run, a phonetic guide, an attribute).
 */
const inlineText = (scan: Scan): Option.Option<string> => {
  if (scan.empty) return Option.some("");
  let text = "";
  // oxlint-disable-next-line effect/imperative-loops -- once per <t> of an inline string
  while (!closeTag(scan, "is")) {
    if (!openTag(scan, "t") || Arr.isReadonlyArrayNonEmpty(scan.names)) return Option.none();
    if (scan.empty) continue;
    const start = scan.p;
    const lt = scan.xml.indexOf("<", start);
    if (lt === NONE) return Option.none();
    text += textOf(scan.xml, start, lt);
    scan.p = lt;
    if (!closeTag(scan, "t")) return Option.none();
  }
  return Option.some(decodeXstring(text));
};

/** Put a valued cell at (`row`, `col`): false when the sheet goes over its budget. */
const addCell = (scan: Scan, row: number, col: number, value: SheetCell | PlainCell): boolean => {
  let cells = scan.lastIndex === row ? scan.last : scan.rows.get(row);
  if (cells === undefined) {
    cells = { cells: [] };
    scan.rows.set(row, cells);
  }
  scan.last = cells;
  scan.lastIndex = row;
  scan.cells += widen(cells, col);
  if (scan.cells > scan.maxCells) return false;
  if (col === cells.cells.length) cells.cells.push(value);
  else place(cells, col, value);
  return true;
};

/**
 * Read the content of a `<c>` whose start tag was just read, and put its
 * value at (`row`, `col`) unless the cell is one the tree path drops (`keep`
 * false: it has no position): false where the scan gives up.
 */
const cellContent = (scan: Scan, row: number, col: number, keep: boolean): boolean => {
  const { xml } = scan;
  // the start tag's `t`, kept across the children's tags
  const tStart = scan.tStart;
  const tEnd = scan.tEnd;
  let vStart = NONE;
  let vEnd = NONE;
  let inline = Option.none<string>();
  if (!scan.empty) {
    // oxlint-disable-next-line effect/imperative-loops -- once per child of a cell (a <v>, or an <is>)
    while (!closeTag(scan, "c")) {
      const lt = xml.indexOf("<", scan.p);
      const end = lt === NONE ? NONE : nameEnd(xml, lt + 1);
      if (end === NONE || !startTag(scan, end)) return false;
      if (isName(xml, lt + 1, end, "v") && vStart === NONE) {
        vStart = vEnd = scan.p;
        if (!scan.empty) {
          vEnd = xml.indexOf("<", vStart);
          scan.p = vEnd;
          if (vEnd === NONE || !closeTag(scan, "v")) return false;
        }
      } else if (isName(xml, lt + 1, end, "is") && Option.isNone(inline)) {
        inline = inlineText(scan);
        if (Option.isNone(inline)) return false;
      } else return false;
    }
  }
  scan.tStart = tStart;
  scan.tEnd = tEnd;
  const value = valueOf(scan, vStart, vEnd, inline);
  return value === BLANK || !keep || addCell(scan, row, col, value);
};

/** Read the cells of a `<row>` whose start tag was just read, at index `rowIndex`: false where the scan gives up. */
const rowContent = (scan: Scan, rowIndex: number): boolean => {
  if (scan.empty) return true;
  const { xml } = scan;
  let colIndex = -1;
  // oxlint-disable-next-line effect/imperative-loops -- once per cell of a large part (bench/xlsx.bench.ts)
  while (!closeTag(scan, "row")) {
    if (!openTag(scan, "c")) return false;
    // as the tree path: a cell with a reference is where it says, one without follows the last
    const ref = readRef(xml, scan.rStart, scan.rEnd);
    const parsed = ref.row !== -1;
    colIndex = parsed ? ref.col : colIndex + 1;
    const row = parsed ? ref.row : rowIndex;
    const placed = Number.isSafeInteger(row) && row >= 0 && Number.isSafeInteger(colIndex);
    if (!cellContent(scan, row, colIndex, placed)) return false;
  }
  return true;
};

/**
 * The rows of a worksheet's `sheetData`, read from `from` (the index past its
 * start tag) to its closing tag, with at most `maxCells` cell positions; none
 * where the scan gives up, for the reader to read the tree instead. For
 * `parseWithScannedContent`.
 */
export const scanSheetData = (
  xml: string,
  from: number,
  sharedStrings: ReadonlyArray<string>,
  maxCells: number,
): Option.Option<ScannedContent<WorksheetRows>> => {
  const scan: Scan = {
    xml,
    sharedStrings,
    maxCells,
    p: from,
    empty: false,
    rStart: NONE,
    rEnd: NONE,
    tStart: NONE,
    tEnd: NONE,
    names: [],
    rows: new Map(),
    last: NO_ROW,
    lastIndex: NONE - 1,
    cells: 0,
  };
  let rowIndex = -1;
  // oxlint-disable-next-line effect/imperative-loops -- once per row of a large part (bench/xlsx.bench.ts)
  while (!closeTag(scan, "sheetData")) {
    if (!openTag(scan, "row")) return Option.none();
    const r = scan.rStart;
    if (r === NONE) rowIndex++;
    else {
      const digits = digitsValue(xml, r, scan.rEnd);
      rowIndex = (digits === -1 ? Number.parseInt(xml.slice(r, scan.rEnd), 10) : digits) - 1;
    }
    if (!rowContent(scan, rowIndex)) return Option.none();
  }
  return Option.some({
    end: scan.p,
    value: { _tag: "Rows", rows: rowsInOrder(scan.rows), cells: scan.cells },
  });
};
