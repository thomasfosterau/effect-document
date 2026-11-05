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
export interface FastPlan {
  readonly separator: number;
  readonly separatorChar: string;
  /** The wrapper, or "" when quoting is off. */
  readonly wrapper: string;
  /** The wrapper doubled: how it is written inside a quoted field. */
  readonly doubledWrapper: string;
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
export const fastPlan = (dialect: CsvDialect, options: CsvScanOptions): Option.Option<FastPlan> => {
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
    separatorChar: separator,
    wrapper,
    doubledWrapper: wrapper + wrapper,
    quote: wrapper === "" ? -1 : wrapper.charCodeAt(0),
    // the scan's default, for callers that pass options as given
    filterEmpty: options.filterEmpty ?? true,
  });
};

/** Whether a character is the whitespace a blank line may hold (` \t\f\v`, less the separator). */
const isBlank = (c: number, plan: FastPlan): boolean =>
  c !== plan.separator && (c === 32 || c === 9 || c === 12 || c === 11);

/** The index of the line break (or the end) ending a blank line at `p`, else -1. */
const blankLineEnd = (text: string, p: number, plan: FastPlan): number => {
  // a line starting past the space character is no blank line: almost every one
  if (text.charCodeAt(p) > 32) return -1;
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

/** The index of the separator or line break (or the end) after text at `p`, a character at a time. */
const textEnd = (text: string, p: number, separator: number): number => {
  let q = p;
  // oxlint-disable-next-line effect/imperative-loops -- a character scan, of the text after a closing wrapper (almost always none)
  for (; q < text.length; q++) {
    const c = text.charCodeAt(q);
    if (c === separator || c === LF || c === CR) break;
  }
  return q;
};

/**
 * The scan's state between fields: where the next separator, LF and CR are
 * (each found with `indexOf`, a native search, and searched for again only
 * once the scan has passed it: one search per field for the separator, one
 * per line for the line break, and for a file without CRs one in all), and
 * the row of the previous record's width that each record's fields start as
 * a copy of (exactly as long as the row and packed, where an array grown by
 * `push` reserves 17 slots on its first push).
 */
interface Scan<T> {
  separator: number;
  lf: number;
  cr: number;
  template: Array<T>;
  /** Whether the quoted field just read holds a doubled wrapper. */
  doubled: boolean;
  /** The value of the quoted field just read. */
  quoted: string;
}

/** The index of `c` at or after `p` in `text`, or its length if there is none. */
const find = (text: string, c: string, p: number): number => {
  const i = text.indexOf(c, p);
  return i === -1 ? text.length : i;
};

/** The end of unquoted text at `p`: the next separator or line break, or the end. */
const unquotedEnd = (text: string, p: number, plan: FastPlan, scan: Scan<unknown>): number => {
  if (scan.separator < p) scan.separator = find(text, plan.separatorChar, p);
  if (scan.lf < p) scan.lf = find(text, "\n", p);
  if (scan.cr < p) scan.cr = find(text, "\r", p);
  const end = scan.separator < scan.lf ? scan.separator : scan.lf;
  return scan.cr < end ? scan.cr : end;
};

/**
 * The index of the wrapper closing a quoted field whose content starts at
 * `from`: the first one not doubled. -1 if the field is never closed.
 */
const closingWrapper = (
  text: string,
  from: number,
  plan: FastPlan,
  scan: Scan<unknown>,
): number => {
  let i = text.indexOf(plan.wrapper, from);
  scan.doubled = false;
  // oxlint-disable-next-line effect/imperative-loops -- one native search per wrapper in the field
  while (i !== -1 && text.charCodeAt(i + 1) === plan.quote) {
    scan.doubled = true;
    i = text.indexOf(plan.wrapper, i + 2);
  }
  return i;
};

/** A quoted field's value: its content, each doubled wrapper halved if it has any. */
const unquote = (
  text: string,
  start: number,
  close: number,
  plan: FastPlan,
  doubled: boolean,
): string => {
  const raw = text.slice(start, close);
  return doubled ? raw.replaceAll(plan.doubledWrapper, plan.wrapper) : raw;
};

/**
 * Read the quoted field at `p` into `scan.quoted`: its content, doubled
 * wrappers halved, then any text after the closing wrapper as written. The
 * index past it, or -1 if it is never closed.
 */
const readQuoted = (text: string, p: number, plan: FastPlan, scan: Scan<unknown>): number => {
  const close = closingWrapper(text, p + 1, plan, scan);
  if (close === -1) return -1;
  const value = unquote(text, p + 1, close, plan, scan.doubled);
  const end = textEnd(text, close + 1, plan.separator);
  scan.quoted = end === close + 1 ? value : value + text.slice(close + 1, end);
  return end;
};

/**
 * How a scan makes its fields: from the text an unquoted field spans, or from
 * a quoted field's value, each given its index in the record. The string
 * scan slices; a typed one can read a number from the text it spans without
 * making the string first.
 */
export interface FieldReader<T> {
  readonly unquoted: (text: string, start: number, end: number, n: number) => T;
  readonly quoted: (value: string, n: number) => T;
  /** What a record's array is filled with before its fields are read. */
  readonly fill: T;
}

/** The string scan's fields: the text each spans. */
const STRINGS: FieldReader<string> = {
  unquoted: (text, start, end) => text.slice(start, end),
  quoted: (value) => value,
  fill: "",
};

/**
 * Read the record at `p` and hand it to `onRow`, as the grammar reads it:
 * fields up to the line break, a quoted one with any text after its closing
 * wrapper kept as written. The index past its line break, {@link UNCLOSED}
 * on an unclosed quote, or {@link STOPPED} when `onRow` returns false.
 */
const readRecord = <T>(
  text: string,
  start: number,
  plan: FastPlan,
  scan: Scan<T>,
  reader: FieldReader<T>,
  onRow: (fields: Array<T>) => boolean,
): number => {
  const fields = scan.template.slice();
  let p = start;
  let n = 0;
  // oxlint-disable-next-line effect/imperative-loops -- once per field of the file: the measured hot path (bench/csv.bench.ts)
  for (;;) {
    let value: T;
    if (text.charCodeAt(p) === plan.quote) {
      p = readQuoted(text, p, plan, scan);
      if (p === -1) return UNCLOSED;
      value = reader.quoted(scan.quoted, n);
    } else {
      const end = unquotedEnd(text, p, plan, scan);
      value = reader.unquoted(text, p, end, n);
      p = end;
    }
    if (n < fields.length) fields[n] = value;
    else fields.push(value);
    n++;
    if (text.charCodeAt(p) !== plan.separator) break;
    p++;
  }
  // a record of another width: trim the copy, and size the next one to it
  if (n !== scan.template.length) {
    fields.length = n;
    scan.template = fields.map(() => reader.fill);
  }
  if (!onRow(fields)) return STOPPED;
  return afterLineBreak(text, p);
};

/** {@link readRecord}: a quoted field is never closed. */
const UNCLOSED = -1;
/** {@link readRecord}: the row callback stopped the scan. */
const STOPPED = -2;

/** How a {@link fastEachRow} scan ended. */
export type FastScanEnd = "done" | "unclosed" | "stopped";

/**
 * Scan `text` as the row grammar does under `plan`, handing each record to
 * `onRow` as soon as it is read (blank lines left out when `filterEmpty` is
 * set), so a caller can build from a row and let it go. `onRow` returns
 * false to stop. `"unclosed"` if a quoted field is never closed (the grammar
 * reports where).
 */
export const fastEachRow = (
  text: string,
  plan: FastPlan,
  onRow: (fields: Array<string>) => boolean,
): FastScanEnd => fastEachRecord(text, plan, STRINGS, onRow);

/** {@link fastEachRow}, each field made by `reader`. */
export const fastEachRecord = <T>(
  text: string,
  plan: FastPlan,
  reader: FieldReader<T>,
  onRow: (fields: Array<T>) => boolean,
): FastScanEnd => {
  const scan: Scan<T> = {
    separator: -1,
    lf: -1,
    cr: -1,
    template: [],
    doubled: false,
    quoted: "",
  };
  let p = 0;
  // oxlint-disable-next-line effect/imperative-loops -- once per line of the file
  while (p < text.length) {
    const blank = plan.filterEmpty ? blankLineEnd(text, p, plan) : -1;
    p = blank !== -1 ? afterLineBreak(text, blank) : readRecord(text, p, plan, scan, reader, onRow);
    if (p === UNCLOSED) return "unclosed";
    if (p === STOPPED) return "stopped";
  }
  return "done";
};

/**
 * Scan `text` as the row grammar does under `plan`: its records, blank lines
 * left out when `filterEmpty` is set; none if a quoted field is never closed
 * (the grammar reports where). `text` has no byte order mark.
 */
export const fastScan = (
  text: string,
  plan: FastPlan,
): Option.Option<Array<ReadonlyArray<string>>> => {
  const rows: Array<ReadonlyArray<string>> = [];
  const end = fastEachRow(text, plan, (fields) => {
    rows.push(fields);
    return true;
  });
  return end === "done" ? Option.some(rows) : Option.none();
};
