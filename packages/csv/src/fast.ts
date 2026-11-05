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
import * as Predicate from "effect/Predicate";
import type { CsvDialect } from "./dialect.ts";
import type { CsvScanOptions } from "./scanner.ts";
import { copyRow } from "./row.ts";

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
 * the scratch arrays each record's fields are read into before the record
 * is copied out by a literal of its width (`row.ts`).
 */
interface Scan<T> {
  separator: number;
  lf: number;
  cr: number;
  /** The array a record's fields are read into, reused from record to record. */
  scratch: Array<T>;
  /**
   * The scratch for records of numbers, while rows keep being all numbers:
   * a packed array of doubles in V8, each number held unboxed, so the row
   * copied from it is one too (8 bytes a number, no heap number for the
   * collector to copy), where {@link scratch} boxes every number that is not
   * a small integer (bench/csv.bench.ts, a table of numbers).
   */
  numbers: Option.Option<Array<T>>;
  /** Whether the record being read is in the number scratch. */
  doubles: boolean;
  /** Whether the quoted field just read holds a doubled wrapper. */
  doubled: boolean;
  /** The value of the quoted field just read. */
  quoted: string;
  /** The field just read, as the reader makes it. */
  field: T;
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

/**
 * A quoted field's value: its content, each doubled wrapper halved if it has
 * any. The halved value is joined from the slices between the doubled
 * wrappers (a native search each), about twice as fast as `replaceAll` over
 * the content's slice (bench/csv.bench.ts, every field quoted). Every
 * doubled wrapper before `close` is an escape: `close` is the first wrapper
 * not doubled.
 */
const unquote = (
  text: string,
  start: number,
  close: number,
  plan: FastPlan,
  doubled: boolean,
): string => {
  if (!doubled) return text.slice(start, close);
  let value = "";
  let from = start;
  let at = text.indexOf(plan.doubledWrapper, from);
  // oxlint-disable-next-line effect/imperative-loops -- one native search per doubled wrapper in the field
  while (at !== -1 && at < close) {
    value += text.slice(from, at + 1);
    from = at + 2;
    at = text.indexOf(plan.doubledWrapper, from);
  }
  return value + text.slice(from, close);
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
  /**
   * Whether {@link unquoted} reads a field from the text it spans; otherwise
   * an unquoted field is sliced and given to {@link quoted}, which keeps the
   * string scan's call sites to one target each.
   */
  readonly inPlace: boolean;
  readonly unquoted: (text: string, start: number, end: number, n: number) => T;
  readonly quoted: (value: string, n: number) => T;
  /** A placeholder field: the scan's field before the first is read. */
  readonly fill: T;
}

/** The string scan's fields: the text each spans. */
const STRINGS: FieldReader<string> = {
  inPlace: false,
  unquoted: (text, start, end) => text.slice(start, end),
  quoted: (value) => value,
  fill: "",
};

/**
 * Read field `n` at `p` into `scan.field`, quoted or not: the index past it,
 * or {@link UNCLOSED} on an unclosed quote.
 */
const readField = <T>(
  text: string,
  p: number,
  plan: FastPlan,
  scan: Scan<T>,
  reader: FieldReader<T>,
  n: number,
): number => {
  if (text.charCodeAt(p) === plan.quote) {
    const next = readQuoted(text, p, plan, scan);
    if (next !== -1) scan.field = reader.quoted(scan.quoted, n);
    return next === -1 ? UNCLOSED : next;
  }
  const end = unquotedEnd(text, p, plan, scan);
  scan.field = reader.inPlace
    ? reader.unquoted(text, p, end, n)
    : reader.quoted(text.slice(p, end), n);
  return end;
};

/**
 * Read the record at `p` and hand it to `onRow`, as the grammar reads it:
 * fields up to the line break, a quoted one with any text after its closing
 * wrapper kept as written. The index past its line break, {@link UNCLOSED}
 * on an unclosed quote, or {@link STOPPED} when `onRow` returns false.
 */
/**
 * A reader of the record at `start`: hands its fields to `onRow`, and
 * returns the index past its line break, {@link UNCLOSED} or {@link STOPPED}.
 */
type RecordReader = <T>(
  text: string,
  start: number,
  plan: FastPlan,
  scan: Scan<T>,
  reader: FieldReader<T>,
  onRow: (fields: Array<T>, numbers: boolean) => boolean,
) => number;

const readRecord: RecordReader = (text, start, plan, scan, reader, onRow) => {
  const fields = startRecord(scan);
  let p = start;
  let n = 0;
  // only a reader that reads fields in place makes numbers: the string scan
  // skips the tracking (6 of its 40 ms on bench/csv.bench.ts's floats table)
  let allNumbers = reader.inPlace;
  // oxlint-disable-next-line effect/imperative-loops -- once per field of the file: the measured hot path (bench/csv.bench.ts)
  for (;;) {
    p = readField(text, p, plan, scan, reader, n);
    if (p === UNCLOSED) return UNCLOSED;
    const number = place(scan, fields, n, scan.field);
    if (allNumbers) allNumbers = number;
    n++;
    if (text.charCodeAt(p) !== plan.separator) break;
    p++;
  }
  return endRecord(text, p, scan, fields, n, allNumbers, onRow);
};

/**
 * The scratch array a record's fields are read into: the number scratch
 * while rows are all numbers (so it holds doubles), else the scratch. A
 * branch, not `Option.getOrElse`: its thunk would be a closure a row.
 */
const startRecord = <T>(scan: Scan<T>): Array<T> => {
  const numbers = scan.numbers;
  scan.doubles = Option.isSome(numbers);
  return Option.isSome(numbers) ? numbers.value : scan.scratch;
};

/** Put field `n` of a record (see {@link storeNumber}): whether it is a number. */
const place = <T>(scan: Scan<T>, fields: Array<T>, n: number, value: T): boolean => {
  const number = Predicate.isNumber(value);
  if (number && scan.doubles) storeNumber(fields, n, value);
  else store(fields, n, value);
  return number;
};

/**
 * Finish a record of `n` fields ending at `p` (its line break): copy it out
 * of the scratch (see `row.ts`), keep or drop the number scratch, hand the
 * row to `onRow` (with whether it is a row of numbers copied from the number
 * scratch, an array of doubles), and return the index past its line break, or
 * {@link STOPPED}.
 */
const endRecord = <T>(
  text: string,
  p: number,
  scan: Scan<T>,
  fields: Array<T>,
  n: number,
  allNumbers: boolean,
  onRow: (fields: Array<T>, numbers: boolean) => boolean,
): number => {
  const numbers = allNumbers && scan.doubles;
  const row = copyRow(fields, n, numbers);
  keepNumbers(scan, fields, n, allNumbers);
  return onRow(row, numbers) ? afterLineBreak(text, p) : STOPPED;
};

/** Set field `n` of a record's array (growing it by one when `n` is its length). */
const store = <T>(fields: Array<T>, n: number, value: T): void => {
  if (n < fields.length) fields[n] = value;
  else fields.push(value);
};

/**
 * {@link store} for a number into the number scratch:
 * a store site of its own, which only ever meets arrays of doubles and
 * numbers, so V8 keeps it storing doubles. Shared with the generic store, it
 * learns from generic arrays and turns these to generic ones too.
 */
const storeNumber = <T>(fields: Array<T>, n: number, value: T): void => {
  if (n < fields.length) fields[n] = value;
  else fields.push(value);
};

/**
 * Keep or drop the number scratch after a row: dropped when the row held
 * anything but numbers (it may then hold other values), made from the row
 * when it held only numbers and there was none.
 */
const keepNumbers = <T>(scan: Scan<T>, fields: Array<T>, n: number, allNumbers: boolean): void => {
  const doubles = Option.isSome(scan.numbers);
  if (!allNumbers) {
    if (doubles) scan.numbers = Option.none();
  }
  // a scratch of doubles, not of the row's own values: a row of small
  // integers would give an array of small integers, which each later row
  // leaves (`map` builds its array by kind; `slice` would copy a generic one)
  else if (!doubles) scan.numbers = Option.some(fields.slice(0, n).map(doubleFill));
};

/**
 * A placeholder the number scratch is filled with: a double that is not a
 * small integer, so the scratch's array holds doubles.
 */
const doubleFill = <T>(value: T): T =>
  // SAFETY: only a value that is a number is replaced, so T holds numbers; the placeholder is overwritten before the row is read
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion, effect/casting-awareness, effect/require-safety-comment-for-type-assertion -- SAFETY: as above
  Predicate.isNumber(value) ? (0.5 as T & number) : value;

/**
 * {@link readRecord} for text with no wrapper in it (quoting off): no field
 * is tested for a quote, and each is read by the reader in place. A loop of
 * its own, as the string scan's is: the general one's per-field branches and
 * calls cost a fifth of a scan of short fields (bench/csv.bench.ts).
 */
const plainRecord: RecordReader = (text, start, plan, scan, reader, onRow) => {
  const fields = startRecord(scan);
  let allNumbers = true;
  let p = start;
  let n = 0;
  // oxlint-disable-next-line effect/imperative-loops -- once per field of the file: the measured hot path (bench/csv.bench.ts)
  for (;;) {
    const end = unquotedEnd(text, p, plan, scan);
    const number = place(scan, fields, n, reader.unquoted(text, p, end, n));
    if (allNumbers) allNumbers = number;
    n++;
    p = end;
    if (text.charCodeAt(end) !== plan.separator) break;
    p++;
  }
  return endRecord(text, p, scan, fields, n, allNumbers, onRow);
};

/**
 * The string scan's record of text with no wrapper in it: each field the
 * slice it spans, with no reader between (the indirection alone cost the
 * scan a fifth on short fields: bench/csv.bench.ts, level with uDSV without).
 */
const stringRecord = (
  text: string,
  start: number,
  plan: FastPlan,
  scan: Scan<string>,
  onRow: (fields: Array<string>) => boolean,
): number => {
  const fields = scan.scratch;
  let p = start;
  let n = 0;
  // oxlint-disable-next-line effect/imperative-loops -- once per field of the file: the measured hot path (bench/csv.bench.ts)
  for (;;) {
    const end = unquotedEnd(text, p, plan, scan);
    store(fields, n, text.slice(p, end));
    n++;
    p = end;
    if (text.charCodeAt(end) !== plan.separator) break;
    p++;
  }
  return onRow(copyRow(fields, n, false)) ? afterLineBreak(text, p) : STOPPED;
};

/** A fresh scan state, its fields placeholders `fill`. */
const newScan = <T>(fill: T): Scan<T> => ({
  separator: -1,
  lf: -1,
  cr: -1,
  scratch: [],
  numbers: Option.none(),
  doubles: false,
  doubled: false,
  quoted: "",
  field: fill,
});

/** {@link readRecord}: a quoted field is never closed. */
const UNCLOSED = -1;
/** {@link readRecord}: the row callback stopped the scan. */
const STOPPED = -2;

/**
 * The plan for `text`: quoting off when the text holds no wrapper at all, so
 * no field is tested for one (one native search a file; most files of
 * numbers quote nothing).
 */
const unquotedPlan = (text: string, plan: FastPlan): FastPlan =>
  plan.quote === -1 || text.includes(plan.wrapper) ? plan : { ...plan, quote: -1 };

/** How a {@link fastEachRow} scan ended. */
export type FastScanEnd = "done" | "unclosed" | "stopped";

/**
 * Scan `text` as the row grammar does under `plan`, handing each record to
 * `onRow` as soon as it is read (blank lines left out when `filterEmpty` is
 * set), so a caller can build from a row and let it go. `onRow` returns
 * false to stop. `"unclosed"` if a quoted field is never closed (the grammar
 * reports where).
 */
const fastEachRow = (
  text: string,
  given: FastPlan,
  onRow: (fields: Array<string>) => boolean,
): FastScanEnd => {
  const plan = unquotedPlan(text, given);
  if (plan.quote !== -1) return fastEachRecord(text, plan, STRINGS, onRow);
  const scan = newScan("");
  return eachLine(text, plan, (p) => stringRecord(text, p, plan, scan, onRow));
};

/**
 * Read `text` line by line, each record with `record` (the index past it,
 * or {@link UNCLOSED} or {@link STOPPED}), blank lines skipped when
 * `filterEmpty` is set.
 */
const eachLine = (text: string, plan: FastPlan, record: (p: number) => number): FastScanEnd => {
  let p = 0;
  // oxlint-disable-next-line effect/imperative-loops -- once per line of the file
  while (p < text.length) {
    const blank = plan.filterEmpty ? blankLineEnd(text, p, plan) : -1;
    p = blank !== -1 ? afterLineBreak(text, blank) : record(p);
    if (p === UNCLOSED) return "unclosed";
    if (p === STOPPED) return "stopped";
  }
  return "done";
};

/** {@link fastEachRow}, each field made by `reader`. */
export const fastEachRecord = <T>(
  text: string,
  given: FastPlan,
  reader: FieldReader<T>,
  onRow: (fields: Array<T>, numbers: boolean) => boolean,
): FastScanEnd => {
  const plan = unquotedPlan(text, given);
  const plain = plan.quote === -1 && reader.inPlace;
  const scan = newScan(reader.fill);
  return eachLine(
    text,
    plan,
    plain
      ? (p) => plainRecord(text, p, plan, scan, reader, onRow)
      : (p) => readRecord(text, p, plan, scan, reader, onRow),
  );
};

/**
 * Scan `text` as the row grammar does under `plan`: its records, blank lines
 * left out when `filterEmpty` is set, the first held apart when `holdFirst`
 * is set (a header row); none if a quoted field is never closed (the grammar
 * reports where). `text` has no byte order mark.
 */
export const fastScan = (
  text: string,
  plan: FastPlan,
  holdFirst: boolean,
): Option.Option<FastTable> => {
  const rows: Array<ReadonlyArray<string>> = [];
  let first = Option.none<ReadonlyArray<string>>();
  let hold = holdFirst;
  const end = fastEachRow(text, plan, (fields) => {
    if (hold) {
      first = Option.some(fields);
      hold = false;
    } else rows.push(fields);
    return true;
  });
  return end === "done" ? Option.some({ first, rows }) : Option.none();
};

/** {@link fastScan}'s records: the first held apart (when asked and there is one), then the rest. */
export interface FastTable {
  readonly first: Option.Option<ReadonlyArray<string>>;
  readonly rows: Array<ReadonlyArray<string>>;
}
