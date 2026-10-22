/**
 * The CSV Reader: CSV text -> a single-worksheet document in the CSV profile.
 *
 * Optional type inference turns raw strings into number/boolean/blank cells;
 * with inference off, every value stays a text cell so cell *values* are
 * preserved exactly (note: the scanner drops blank lines and the writer
 * normalizes the trailing newline, so text is not necessarily byte-identical).
 */

import * as Predicate from "effect/Predicate";
import * as Effect from "effect/Effect";
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
  SheetRow,
  trustAs,
  Worksheet,
} from "@thomasfosterau/effect-document";
import { Csv } from "@thomasfosterau/effect-document/profiles";
import { StandardDialect, type CsvDialect } from "./dialect.ts";
import { scanCsv, scanCsvStream, type CsvScanOptions } from "./scanner.ts";

/** The features the CSV profile allows, as a type: the phantom of its documents. */
export type CsvFeature = FeaturesOf<typeof Csv>;

/** How raw strings become typed values. The option names follow CSVW where it has one. */
export interface CsvInferenceOptions {
  /**
   * `cell` (the default): each value is inferred on its own, so a column may
   * mix types. `column`: a column is numeric only if every non-null value in it
   * is a number, and boolean only if every one is a boolean; otherwise the
   * whole column is text. Without `treatFirstRowAsHeader` the header row counts
   * as data, so its names make every column text.
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
   * Without `treatFirstRowAsHeader`, a numeric header row is read as numbers.
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

/** Build the value classifier for a set of inference options. */
const makeClassifier = (options: CsvInferenceOptions): ((raw: string) => Inferred) => {
  const nulls = new Set(options.nullValues ?? [""]);
  const caseSensitive = !!options.booleansCaseSensitive;
  const fold = (s: string) => (caseSensitive ? s : s.toLowerCase());
  const [truthy, falsy] =
    options.booleans === false ? [] : (options.booleans ?? ["true", "false"]).map(fold);
  const group = options.groupChar ? escapeRegExp(options.groupChar) : undefined;
  const integer =
    group === undefined ? "0|[1-9]\\d*" : `0|[1-9]\\d{0,2}(?:${group}\\d{3})+|[1-9]\\d*`;
  const number = new RegExp(
    `^(-?)(${integer})(?:${escapeRegExp(options.decimalChar ?? ".")}(\\d+))?(?:[eE]([+-]?\\d+))?${options.percent ? "(%?)" : "()"}$`,
  );
  const groups = group === undefined ? undefined : new RegExp(group, "g");
  return (raw) => {
    if (nulls.has(raw)) return null;
    const folded = fold(raw);
    if (folded === truthy) return true;
    if (folded === falsy) return false;
    const m = number.exec(raw);
    if (m === null) return undefined;
    const [, sign, grouped = "", frac = "", exp = "0", pct] = m;
    const int = groups === undefined ? grouped : grouped.replace(groups, "");
    // a percentage shifts the exponent, so `7%` parses exactly as 0.07
    const value = Number(`${sign}${int}.${frac || "0"}e${Number(exp) - (pct ? 2 : 0)}`);
    return holdsDigits(value, int + frac) ? value : undefined;
  };
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
  toCell(raw, (options === undefined ? defaultClassifier : makeClassifier(options))(raw));

/** Type rows of raw values, by column or by cell. */
const inferRows = (
  rows: ReadonlyArray<ReadonlyArray<string>>,
  options: CsvInferenceOptions,
  classify: (raw: string) => Inferred,
): Array<Array<SheetCell>> => {
  const values = rows.map((row) => row.map(classify));
  if (options.inference !== "column")
    return rows.map((row, r) => row.map((raw, c) => toCell(raw, values[r]![c])));
  // each column's type, from its non-null values (undefined while it has none)
  const columns: Array<"number" | "boolean" | "text" | undefined> = [];
  for (const row of values) {
    row.forEach((value, c) => {
      if (value === null || columns[c] === "text") return;
      const kind = value === undefined ? "text" : Predicate.isNumber(value) ? "number" : "boolean";
      columns[c] = columns[c] === undefined || columns[c] === kind ? kind : "text";
    });
  }
  return rows.map((row, r) =>
    row.map((raw, c) => {
      const value = values[r]![c];
      return toCell(raw, value === null || columns[c] !== "text" ? value : undefined);
    }),
  );
};

// ============================================================================
// Reader
// ============================================================================

/** Create a CSV Reader with the given options baked in. */
export const makeCsvReader = (options?: CsvReaderOptions): Reader<CsvFeature> => {
  const dialect = options?.dialect ?? StandardDialect;
  const inferTypes = options?.inferTypes ?? true;
  const sheetName = options?.sheetName ?? "Sheet1";
  const classify = makeClassifier(options ?? {});

  const read = (input: Content): Effect.Effect<Doc<CsvFeature>, ParseError> =>
    pipe(
      scanCsv(contentToText(input), dialect, options),
      Effect.map(({ headers, rows }) => {
        const body = inferTypes
          ? inferRows(rows, options ?? {}, classify)
          : rows.map((row) => row.map(cell.text));
        const grid = headers === null ? body : [headers.map((h) => cell.text(h)), ...body];
        const ws = new Worksheet({
          name: sheetName,
          columns: [],
          rows: grid.map((cells) => new SheetRow({ cells })),
          merges: [],
        });
        return trustAs<CsvFeature>(document([ws]));
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
