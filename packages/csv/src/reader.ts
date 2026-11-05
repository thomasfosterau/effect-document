/**
 * The CSV Reader: CSV text -> a single-worksheet document in the CSV profile.
 *
 * Optional type inference turns raw strings into number/boolean/blank cells;
 * with inference off, every value stays a text cell so cell *values* are
 * preserved exactly (note: the scanner drops blank lines and the writer
 * normalizes the trailing newline, so text is not necessarily byte-identical).
 */

import * as Arr from "effect/Array";
import * as Predicate from "effect/Predicate";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { pipe } from "effect/Function";
import {
  cell,
  type Content,
  contentToText,
  type Doc,
  document,
  type FeaturesOf,
  makeReaderTag,
  type ParseError,
  type Reader,
  type SheetCell,
  type SheetRow,
  sheetRow,
  trustAs,
  worksheetFromRows,
} from "@thomasfosterau/effect-document";
import { Csv } from "@thomasfosterau/effect-document/profiles";
import { StandardDialect, type CsvDialect } from "./dialect.ts";
import { scanCsv, scanCsvStream, type CsvScanOptions } from "./scanner.ts";
import { fastPlan } from "./fast.ts";
import { type ColumnKind, type FusedOptions, fusedRows, type Typing } from "./fused.ts";

/** The features the CSV profile allows, as a type: the phantom of its documents. */
export type CsvFeature = FeaturesOf<typeof Csv>;

/** How raw strings become typed values. The option names follow CSVW where it has one. */
export interface CsvInferenceOptions {
  /**
   * `column` (the default): a column is numeric only if every non-null value
   * in it is a number, and boolean only if every one is a boolean; otherwise
   * the whole column is text, so a stray code such as `007` keeps its column's
   * other values as written too. `cell`: each value is inferred on its own, so
   * a column may mix types. A header row is left out of inference (see
   * `treatFirstRowAsHeader` on the reader options for how it is found).
   */
  readonly inference?: "column" | "cell" | undefined;
  /**
   * The spellings of true and false, matched case-insensitively unless
   * `booleansCaseSensitive` is set (defaults to `["true", "false"]`). `false`
   * turns boolean inference off.
   */
  readonly booleans?: readonly [truthy: string, falsy: string] | false | undefined;
  readonly booleansCaseSensitive?: boolean | undefined;
  /** The decimal separator of numbers (defaults to "."). */
  readonly decimalChar?: string | undefined;
  /**
   * The digit-group separator of numbers, such as "," for `1,234.56` (none by
   * default). Groups must be three digits; ungrouped numbers still parse.
   */
  readonly groupChar?: string | undefined;
  /** Read a trailing `%` as a percentage: `12%` becomes 0.12. Off by default. */
  readonly percent?: boolean | undefined;
  /** Values read as blank cells, matched exactly (defaults to `[""]`). */
  readonly nullValues?: ReadonlyArray<string> | undefined;
}

/** Options for the CSV reader: the dialect, the scan options and type inference. */
export interface CsvReaderOptions extends CsvScanOptions, CsvInferenceOptions {
  /**
   * Whether the first row is the header. Unset (the default), the reader
   * sniffs it, as Python's `csv.Sniffer.has_header` does: the first row is the
   * header when there are at least two rows, every first-row value is
   * non-empty text, and at least one column's other values all infer as
   * numbers or booleans. `true` or `false` overrides the sniff, so a file
   * whose columns are all text needs `true` for its header row to be one. The
   * header row is read as text cells and left out of inference. (`readStream`
   * does not infer types, so it does not sniff: unset means no header there.)
   */
  readonly treatFirstRowAsHeader?: boolean | undefined;
  /** The CSV dialect to parse with (defaults to StandardDialect). */
  readonly dialect?: CsvDialect | undefined;
  /**
   * Infer cell types from string values: numbers, booleans and null values
   * (-> blank cells), shaped by the {@link CsvInferenceOptions}. Set to false to
   * keep every value as a text cell, preserving values exactly. Defaults to
   * true.
   *
   * Inference is convenient but lossy. Only plain decimals are read as numbers
   * (`-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?`) whose digits a double holds exactly,
   * so codes such as `007`, `0x1F`, `+1` and 20-digit IDs stay text. Numbers
   * still lose their written form: `1.10` reads as 1.1 and `1e3` as 1000.
   * With `treatFirstRowAsHeader: false`, a numeric first row is read as numbers.
   */
  readonly inferTypes?: boolean | undefined;
  /** Name of the produced worksheet (defaults to "Sheet1"). */
  readonly sheetName?: string | undefined;
}

// ============================================================================
// Inference
// ============================================================================

/** A raw value's inferred type: a number, a boolean, `null` for blank, or `undefined` for text. */
type Inferred = number | boolean | null | undefined;

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Significant digits: from the first non-zero digit to the last. */
const significantDigits = (digits: string): string => digits.replace(/^0+/, "").replace(/0+$/, "");

/**
 * Whether a double holds exactly the written digits: its shortest decimal
 * form has the same significant digits. `0.30000000000000004` does; a 20-digit
 * ID or 2^53 + 1 does not, and stays text rather than silently changing.
 */
const holdsDigits = (value: number, digits: string): boolean =>
  significantDigits(Math.abs(value).toExponential().replace(/e.*$/, "").replace(".", "")) ===
  significantDigits(digits);

/**
 * The most digits a double always holds exactly (`DBL_DIG`): a decimal of at
 * most this many digits, with no exponent, reads back as written, so it needs
 * no {@link holdsDigits} check.
 */
const exactDigits = 15;

const isDigit = (c: number): boolean => c >= 48 && c <= 57;

/** {@link plainDigits}: the value matched but has an exponent, so take the general path. */
const WITH_EXPONENT = -2;

/** The index past the run of digits in `raw` from `i`. */
const skipDigits = (raw: string, i: number): number => {
  let j = i;
  // oxlint-disable-next-line effect/imperative-loops -- a character scan, run on every value that may be a number
  while (j < raw.length && isDigit(raw.charCodeAt(j))) j++;
  return j;
};

/** The index past an integer part (`0|[1-9]\d*`) at `i`, or -1 if there is none. */
const integerEnd = (raw: string, i: number): number => {
  const lead = raw.charCodeAt(i);
  if (lead === 48) return i + 1;
  return lead >= 49 && lead <= 57 ? skipDigits(raw, i) : -1;
};

/** Whether an exponent (`[eE][+-]?\d+`) runs from `i` to the end of `raw`. */
const isExponent = (raw: string, i: number): boolean => {
  const e = raw.charCodeAt(i);
  if (e !== 101 && e !== 69) return false;
  const sign = raw.charCodeAt(i + 1);
  const start = sign === 43 || sign === 45 ? i + 2 : i + 1;
  const end = skipDigits(raw, start);
  return end > start && end === raw.length;
};

/**
 * Match `raw` against the default number syntax,
 * `-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?`, without a regular expression:
 * the count of its integer and fraction digits, `-1` if it does not match, or
 * {@link WITH_EXPONENT} if it matches with an exponent.
 */
const plainDigits = (raw: string): number => {
  const sign = raw.charCodeAt(0) === 45 ? 1 : 0;
  let i = integerEnd(raw, sign);
  if (i === -1) return -1;
  let digits = i - sign;
  if (raw.charCodeAt(i) === 46) {
    const end = skipDigits(raw, i + 1);
    if (end === i + 1) return -1;
    digits += end - i - 1;
    i = end;
  }
  if (i === raw.length) return digits;
  return isExponent(raw, i) ? WITH_EXPONENT : -1;
};

/** A set of inference options, resolved: the value classifier and its null test. */
interface Classifier extends NumberTest {
  readonly classify: (raw: string) => Inferred;
  /** A value's kind (`blank` for a null spelling), without building its value. */
  readonly kind: (raw: string) => ColumnKind;
  /** Whether a value is one of the null spellings. */
  readonly isNull: (raw: string) => boolean;
  /** The boolean a (non-null) value spells, if any. */
  readonly asBoolean: (raw: string) => boolean | undefined;
}

/** The null test for a set of inference options. */
const makeNullTest = (options: CsvInferenceOptions): ((raw: string) => boolean) => {
  const nulls = new Set(options.nullValues ?? [""]);
  // A set lookup hashes the string, and each scanned value is a fresh one:
  // look up only a value as long as some null spelling.
  const nullLengths = Array.from(nulls, (n) => n.length);
  return (raw) => nullLengths.includes(raw.length) && nulls.has(raw);
};

/** The boolean a value spells, or `undefined` for any other value. */
const makeBooleanTest = (options: CsvInferenceOptions): ((raw: string) => boolean | undefined) => {
  const caseSensitive = !!options.booleansCaseSensitive;
  const fold = (s: string) => (caseSensitive ? s : s.toLowerCase());
  const [truthy, falsy] =
    options.booleans === false ? [] : (options.booleans ?? ["true", "false"]).map(fold);
  // only a value as long as a spelling can be one, so most skip the fold
  const truthyLength = truthy?.length ?? -1;
  const falsyLength = falsy?.length ?? -1;
  return (raw) => {
    if (raw.length !== truthyLength && raw.length !== falsyLength) return undefined;
    const folded = fold(raw);
    return folded === truthy ? true : folded === falsy ? false : undefined;
  };
};

/** How a set of inference options reads numbers. */
interface NumberTest {
  /** Whether a value spells a number, without building the number when it can tell. */
  readonly isNumber: (raw: string) => boolean;
  /** The number a value known to spell one spells (see {@link isNumber}). */
  readonly numberOf: (raw: string) => number;
}

/** Whether a value can be a number: it starts with a digit or a minus sign. */
const mayBeNumber = (raw: string): boolean => {
  const first = raw.charCodeAt(0);
  return first === 45 || (first >= 48 && first <= 57);
};

/** How a set of inference options reads numbers. */
const makeNumberTest = (options: CsvInferenceOptions): NumberTest => {
  const decimalChar = options.decimalChar ?? ".";
  const group = options.groupChar ? escapeRegExp(options.groupChar) : undefined;
  const integer =
    group === undefined ? "0|[1-9]\\d*" : `0|[1-9]\\d{0,2}(?:${group}\\d{3})+|[1-9]\\d*`;
  const number = new RegExp(
    `^(-?)(${integer})(?:${escapeRegExp(decimalChar)}(\\d+))?(?:[eE]([+-]?\\d+))?${options.percent ? "(%?)" : "()"}$`,
  );
  const groups = group === undefined ? undefined : new RegExp(group, "g");
  // Without a group or decimal character of its own or a percent sign, a
  // matched value is a JavaScript numeric literal, so `Number` reads it as is.
  const plain = groups === undefined && decimalChar === ".";
  const fast = plain && !options.percent;
  /** The general path: the grammar as a regular expression, then the digits check. */
  const general = (raw: string): number | undefined => {
    const m = number.exec(raw);
    if (m === null) return undefined;
    const [, sign, grouped = "", frac = "", exp, pct] = m;
    const int = groups === undefined ? grouped : grouped.replace(groups, "");
    // a percentage shifts the exponent, so `7%` parses exactly as 0.07
    const value =
      plain && !pct
        ? Number(raw)
        : Number(`${sign}${int}.${frac || "0"}e${Number(exp ?? "0") - (pct ? 2 : 0)}`);
    const exact = exp === undefined && int.length + frac.length <= exactDigits;
    return exact || holdsDigits(value, int + frac) ? value : undefined;
  };
  // In the common case a plain decimal of at most `exactDigits` digits is a
  // number with no need to build it, and a value known to be one is
  // `Number(raw)` (what `general` computes for it too).
  const isNumber = (raw: string): boolean => {
    if (!mayBeNumber(raw)) return false;
    if (!fast) return general(raw) !== undefined;
    const digits = plainDigits(raw);
    if (digits === -1) return false;
    return (digits !== WITH_EXPONENT && digits <= exactDigits) || general(raw) !== undefined;
  };
  const numberOf = (raw: string): number => (fast ? Number(raw) : (general(raw) ?? Number.NaN));
  return { isNumber, numberOf };
};

/** Build the value classifier for a set of inference options. */
const makeClassifier = (options: CsvInferenceOptions): Classifier => {
  const isNull = makeNullTest(options);
  const asBoolean = makeBooleanTest(options);
  const numbers = makeNumberTest(options);
  const classify = (raw: string): Inferred =>
    isNull(raw)
      ? null
      : (asBoolean(raw) ?? (numbers.isNumber(raw) ? numbers.numberOf(raw) : undefined));
  const kind = (raw: string): ColumnKind =>
    isNull(raw)
      ? "blank"
      : asBoolean(raw) !== undefined
        ? "boolean"
        : numbers.isNumber(raw)
          ? "number"
          : "text";
  return { ...numbers, classify, kind, isNull, asBoolean };
};

const toCell = (raw: string, value: Inferred): SheetCell =>
  value === null
    ? cell.blank()
    : value === undefined
      ? cell.text(raw)
      : Predicate.isNumber(value)
        ? cell.number(value)
        : cell.boolean(value);

const defaultClassifier = makeClassifier({});

/** Infer a typed cell from a raw CSV string value, on its own. */
export const inferCell = (raw: string, options?: CsvInferenceOptions): SheetCell =>
  toCell(raw, (options === undefined ? defaultClassifier : makeClassifier(options)).classify(raw));

/**
 * Whether the first row looks like a header: at least two rows, every
 * first-row value non-empty text, and some column whose other values are all
 * typed (numbers or booleans, blanks aside).
 */
const sniffHeader = (
  rows: ReadonlyArray<ReadonlyArray<string>>,
  classify: (raw: string) => Inferred,
): boolean => {
  const [first, ...rest] = rows;
  if (first === undefined || !Arr.isReadonlyArrayNonEmpty(rest)) return false;
  if (!first.every((raw) => raw.trim() !== "" && classify(raw) === undefined)) return false;
  return first.some((_, c) => {
    // a short row's missing value counts as blank
    const values = Arr.filter(
      rest.map((row) => {
        const raw = row[c];
        return raw === undefined ? null : classify(raw);
      }),
      (v) => v !== null,
    );
    return Arr.isReadonlyArrayNonEmpty(values) && values.every((v) => v !== undefined);
  });
};

/**
 * Type rows of raw values, by column or by cell.
 *
 * By column, a value in a column already known to be text is only checked for
 * being null (it is text either way), so a text column costs one set lookup
 * per value after its first text value.
 */
/**
 * The rows of typed cells, as worksheet rows from `first` on. Each row is
 * built whole as soon as its cells are, so a row's intermediate cell array
 * dies young (and costs the collector nothing) instead of living until every
 * row is typed.
 */
const sheetRows = (
  rows: ReadonlyArray<ReadonlyArray<string>>,
  first: number,
  cellAt: (raw: string, col: number) => SheetCell,
): Array<SheetRow> => rows.map((row, r) => sheetRow(first + r, row.map(cellAt)));

/** How each value becomes a cell: typed by column or by cell, or (off) text as written. */
const cellMaker = (
  rows: ReadonlyArray<ReadonlyArray<string>>,
  options: CsvReaderOptions,
  classifier: Classifier,
): ((raw: string, col: number) => SheetCell) => {
  if (options.inferTypes === false) return (raw) => cell.text(raw);
  const { classify } = classifier;
  if (options.inference === "cell") return (raw) => toCell(raw, classify(raw));
  // By column: a first pass finds each column's kind, and a value's cell then
  // follows from its column's kind alone (a null spelling is blank, anything
  // else is read as its column's type), so no value is kept between passes.
  const kinds = columnKinds(rows, classifier);
  const cellOf = kinds.map((kind) => columnCell(kind, classifier));
  const asText = columnCell("text", classifier);
  return (raw, c) => (cellOf[c] ?? asText)(raw);
};

/** Each column's kind: the type every non-null value in it has, else text. */
const columnKinds = (
  rows: ReadonlyArray<ReadonlyArray<string>>,
  { kind }: Classifier,
): ReadonlyArray<ColumnKind> => {
  const columns: Array<ColumnKind> = [];
  // oxlint-disable-next-line effect/imperative-loops -- once per row of the file, beside the per-value loop in `classifyRow`
  for (const row of rows) classifyRow(row, kind, columns);
  return columns;
};

/** Merge one row's values into each column's kind. */
const classifyRow = (
  row: ReadonlyArray<string>,
  kindOfValue: (raw: string) => ColumnKind,
  columns: Array<ColumnKind>,
): void => {
  // oxlint-disable-next-line effect/imperative-loops -- once per value of the file: the measured hot path (bench/csv.bench.ts), where a callback per value costs
  for (let c = 0; c < row.length; c++) {
    const column = columns[c] ?? "blank";
    // a text column stays text whatever follows
    if (column === "text") continue;
    const kind = kindOfValue(row[c] ?? "");
    if (kind !== "blank") columns[c] = merge(column, kind);
  }
};

/**
 * The cell for a value of a column of `kind`: blank for a null spelling, else
 * the column's type (every non-null value of a number or boolean column is
 * one, so the reading is defined). (Sharing one cell per distinct value was
 * measured: the string hashing a lookup needs costs more than the cells it
 * saves.)
 */
const columnCell = (
  kind: ColumnKind,
  { isNull, asBoolean, numberOf }: Classifier,
): ((raw: string) => SheetCell) => {
  const typed =
    kind === "number"
      ? (raw: string) => cell.number(numberOf(raw))
      : kind === "boolean"
        ? (raw: string) => cell.boolean(asBoolean(raw) ?? false)
        : (raw: string) => cell.text(raw);
  return (raw) => (isNull(raw) ? cell.blank() : typed(raw));
};

/** A column's kind once it also holds a value of `kind`. */
const merge = (column: ColumnKind, kind: ColumnKind): ColumnKind =>
  column === "blank" || column === kind ? kind : "text";

// ============================================================================
// Reader
// ============================================================================

const stripBom = (text: string): string => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);

/**
 * The reader's one-pass read for these options (`fused.ts`), or none when
 * they need the general path: a dialect or option the fast scanner leaves to
 * the grammar, provided headers, or header validation.
 */
const fusedRead = (
  dialect: CsvDialect,
  options: CsvReaderOptions,
  inferTypes: boolean,
  classifier: Classifier,
): Option.Option<(text: string) => Option.Option<ReadonlyArray<SheetRow>>> => {
  if (options.providedHeaders !== undefined || options.validateHeaders) return Option.none();
  const header = options.treatFirstRowAsHeader;
  const fusedOptions: FusedOptions = {
    header: header === undefined ? "sniff" : header ? "first" : "data",
    inferTypes,
    byCell: options.inference === "cell",
    checkWidths: !options.allowVariableColumns,
  };
  const typing: Typing = {
    ...classifier,
    cellOf: (raw) => toCell(raw, classifier.classify(raw)),
    booleanOf: (raw) => classifier.asBoolean(raw) ?? false,
  };
  return Option.map(
    fastPlan(dialect, options),
    (plan) => (text: string) => fusedRows(text, plan, fusedOptions, typing),
  );
};

/** Create a CSV Reader with the given options baked in. */
export const makeCsvReader = (options?: CsvReaderOptions): Reader<CsvFeature> => {
  const dialect = options?.dialect ?? StandardDialect;
  const inferTypes = options?.inferTypes ?? true;
  const sheetName = options?.sheetName ?? "Sheet1";
  const classifier = makeClassifier(options ?? {});

  // unset with no provided headers: scan headerless, then sniff from the types
  const sniff =
    options?.treatFirstRowAsHeader === undefined && options?.providedHeaders === undefined;

  // the one-pass read (fused.ts), for the options it covers
  const fused = fusedRead(dialect, options ?? {}, inferTypes, classifier);
  const asDocument = (rows: ReadonlyArray<SheetRow>): Doc<CsvFeature> =>
    trustAs<CsvFeature>(document([worksheetFromRows(sheetName, rows)]));

  const read = (input: Content): Effect.Effect<Doc<CsvFeature>, ParseError> =>
    Effect.suspend(() => {
      const source = contentToText(input);
      return Option.match(
        Option.flatMap(fused, (one) => one(stripBom(source))),
        {
          onSome: (rows) => Effect.succeed(asDocument(rows)),
          onNone: () => generalRead(source),
        },
      );
    });

  /** The general path: scan, then type by column, then build. */
  const generalRead = (source: string): Effect.Effect<Doc<CsvFeature>, ParseError> =>
    pipe(
      scanCsv(source, dialect, options),
      Effect.map((scanned) => {
        const first = scanned.rows[0];
        // the rest copied out only when the sniff takes the first row
        return sniff && first !== undefined && sniffHeader(scanned.rows, classifier.classify)
          ? { headers: first, rows: scanned.rows.slice(1) }
          : scanned;
      }),
      Effect.map(({ headers, rows }) => {
        const header =
          headers === null
            ? []
            : [
                sheetRow(
                  0,
                  headers.map((h) => cell.text(h)),
                ),
              ];
        const body = sheetRows(
          rows,
          header.length,
          cellMaker(rows, { ...options, inferTypes }, classifier),
        );
        return trustAs<CsvFeature>(
          document([worksheetFromRows(sheetName, headers === null ? body : [...header, ...body])]),
        );
      }),
    );

  const readStream = (input: Content): Stream.Stream<ReadonlyArray<string>, ParseError> =>
    scanCsvStream(Stream.make(contentToText(input)), dialect, options);

  return { format: "csv", profile: Csv, read, readStream };
};

/** Context tag for dependency-injection style usage. */
export const CsvReaderTag = makeReaderTag<CsvFeature>("csv");

/** Layer providing a CSV Reader with default options. */
export const CsvReaderLive = Layer.succeed(CsvReaderTag, makeCsvReader());

/** Layer providing a CSV Reader with custom options. */
export const makeCsvReaderLayer = (options?: CsvReaderOptions) =>
  Layer.succeed(CsvReaderTag, makeCsvReader(options));
