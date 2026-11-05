/**
 * The whole-text scanner's fast path: the row grammar of `scanner.ts`,
 * written out by hand for the dialects and options almost every file uses.
 *
 * `scanCsv` parses with the effect-parse grammar, compiled. For a
 * one-character separator, a one-character wrapper escaped by doubling (or
 * none), and none of the options that reshape fields (`trimWhitespace`,
 * `lineCommentMarker`, `quoteAnywhere`, `skipRows`), this module does the
 * same scan in plain loops: no backtracking, no per-row blank-line probe
 * through the grammar, and quoted fields found with `indexOf` (a native,
 * vectorised search) rather than a character at a time. It returns exactly
 * the rows the grammar returns, blank lines left out; on input the grammar
 * rejects (an unclosed quote) it returns none, and `scanCsv` runs the
 * grammar for its error. `test/csv.test.ts` checks the two against each other
 * on generated input.
 *
 * @internal
 */

import * as Option from "effect/Option";
import type { CsvDialect } from "./dialect.ts";
import type { CsvScanOptions } from "./scanner.ts";

/** What the fast path needs of a dialect, resolved to character codes. */
interface Plan {
  readonly separator: number;
  /** The wrapper, or "" when quoting is off. */
  readonly wrapper: string;
  readonly quote: number;
  readonly filterEmpty: boolean;
}

const CR = 13;
const LF = 10;

/**
 * The fast path's plan for a dialect and options, or none when they
 * need the grammar: a separator or wrapper of more than one character, an
 * escape other than a doubled wrapper, or an option that reshapes fields.
 */
export const fastPlan = (dialect: CsvDialect, options: CsvScanOptions): Option.Option<Plan> => {
  const { separator, wrapper, doubleWrapper } = dialect;
  const simple =
    separator.length === 1 &&
    separator !== "\r" &&
    separator !== "\n" &&
    separator !== wrapper &&
    wrapper.length <= 1 &&
    (wrapper === "" || doubleWrapper === wrapper + wrapper);
  const plain =
    !options.trimWhitespace &&
    !options.lineCommentMarker &&
    !options.quoteAnywhere &&
    (options.skipRows ?? 0) === 0;
  if (!simple || !plain) return Option.none();
  return Option.some({
    separator: separator.charCodeAt(0),
    wrapper,
    quote: wrapper === "" ? -1 : wrapper.charCodeAt(0),
    filterEmpty: !!options.filterEmpty,
  });
};

/** Whether a character is the whitespace a blank line may hold (` \t\f\v`, less the separator). */
const isBlank = (c: number, plan: Plan): boolean =>
  c !== plan.separator && (c === 32 || c === 9 || c === 12 || c === 11);

/** The index of the line break (or the end) ending a blank line at `p`, else -1. */
const blankLineEnd = (text: string, p: number, plan: Plan): number => {
  let q = p;
  // oxlint-disable-next-line effect/imperative-loops -- a character scan, once per line
  while (q < text.length && isBlank(text.charCodeAt(q), plan)) q++;
  const c = text.charCodeAt(q);
  return q === text.length || c === LF || c === CR ? q : -1;
};

/** The index past the line break at `p` (CRLF, LF or a bare CR), or `p` at the end. */
const afterLineBreak = (text: string, p: number): number => {
  const c = text.charCodeAt(p);
  if (c === CR) return text.charCodeAt(p + 1) === LF ? p + 2 : p + 1;
  return c === LF ? p + 1 : p;
};

/** The index of the separator or line break (or the end) after unquoted text at `p`. */
const textEnd = (text: string, p: number, separator: number): number => {
  let q = p;
  // oxlint-disable-next-line effect/imperative-loops -- a character scan, once per unquoted field: the measured hot path (bench/csv.bench.ts)
  for (; q < text.length; q++) {
    const c = text.charCodeAt(q);
    if (c === separator || c === LF || c === CR) break;
  }
  return q;
};

/**
 * The index of the wrapper closing a quoted field whose content starts at
 * `from`: the first one not doubled. -1 if the field is never closed.
 */
const closingWrapper = (text: string, from: number, plan: Plan): number => {
  let i = text.indexOf(plan.wrapper, from);
  // oxlint-disable-next-line effect/imperative-loops -- one native search per wrapper in the field
  while (i !== -1 && text.charCodeAt(i + 1) === plan.quote) i = text.indexOf(plan.wrapper, i + 2);
  return i;
};

/** The scan's position and the field it has just read. */
interface Cursor {
  p: number;
  field: string;
  /**
   * A row of the previous record's width, filled with "": each record's
   * fields start as a copy of it. A copy is exactly as long as the row and
   * packed, where an array grown by `push` from empty reserves 17 slots on
   * its first push (most of the scan's memory, so of its collection time).
   */
  template: Array<string>;
}

/**
 * Read the field at `cursor.p` into `cursor.field` and move past it: a quoted
 * field (its doubled wrappers halved, then any text after the closing wrapper,
 * kept as written) or unquoted text. False on an unclosed quote.
 */
const readField = (text: string, cursor: Cursor, plan: Plan): boolean => {
  const p = cursor.p;
  if (text.charCodeAt(p) !== plan.quote) {
    const end = textEnd(text, p, plan.separator);
    cursor.field = text.slice(p, end);
    cursor.p = end;
    return true;
  }
  const close = closingWrapper(text, p + 1, plan);
  if (close === -1) return false;
  const raw = text.slice(p + 1, close);
  // a wrapper inside the content is always half of a doubled pair
  const value = raw.includes(plan.wrapper)
    ? raw.replaceAll(plan.wrapper + plan.wrapper, plan.wrapper)
    : raw;
  const end = textEnd(text, close + 1, plan.separator);
  cursor.field = end === close + 1 ? value : value + text.slice(close + 1, end);
  cursor.p = end;
  return true;
};

/** Read the record at `cursor.p`, up to its line break; false on an unclosed quote. */
const readRecord = (
  text: string,
  cursor: Cursor,
  plan: Plan,
  rows: Array<ReadonlyArray<string>>,
): boolean => {
  const fields = cursor.template.slice();
  let n = 0;
  // oxlint-disable-next-line effect/imperative-loops -- once per field of the file: the measured hot path (bench/csv.bench.ts)
  for (;;) {
    if (!readField(text, cursor, plan)) return false;
    if (n < fields.length) fields[n] = cursor.field;
    else fields.push(cursor.field);
    n++;
    if (text.charCodeAt(cursor.p) !== plan.separator) break;
    cursor.p++;
  }
  // a record of another width: trim the copy, and size the next one to it
  if (n !== cursor.template.length) {
    fields.length = n;
    cursor.template = fields.map(() => "");
  }
  rows.push(fields);
  cursor.p = afterLineBreak(text, cursor.p);
  return true;
};

/**
 * Scan `text` as the row grammar does under `plan`: its records, blank lines
 * left out when `filterEmpty` is set; none if a quoted field is never
 * closed (the grammar reports where).
 */
export const fastScan = (text: string, plan: Plan): Option.Option<Array<ReadonlyArray<string>>> => {
  const rows: Array<ReadonlyArray<string>> = [];
  const cursor: Cursor = { p: 0, field: "", template: [] };
  // oxlint-disable-next-line effect/imperative-loops -- once per line of the file
  while (cursor.p < text.length) {
    const blank = plan.filterEmpty ? blankLineEnd(text, cursor.p, plan) : -1;
    if (blank !== -1) cursor.p = afterLineBreak(text, blank);
    else if (!readRecord(text, cursor, plan, rows)) return Option.none();
  }
  return Option.some(rows);
};
