/**
 * The CSV Writer: a CSV-profile document -> CSV text.
 *
 * The input type (`Doc<CsvFeature>`) already guarantees a single worksheet of
 * representable cells. The writer fails only when the options forbid quoting
 * and a field cannot be written without it.
 *
 * Rows end with the dialect's `linebreak`, which is LF in `StandardDialect`.
 * Use `Rfc4180Dialect` for the CRLF line endings RFC 4180 specifies.
 */

import * as Predicate from "effect/Predicate";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import {
  cellToText,
  type Content,
  DEFAULT_MAX_DENSE_CELLS,
  denseSize,
  type Doc,
  type FeaturesOf,
  makeWriterTag,
  type SheetRow,
  sheetExtent,
  text,
  type Worksheet,
  WriteError,
  type Writer,
} from "@thomasfosterau/effect-document";
import { Csv } from "@thomasfosterau/effect-document/profiles";
import { StandardDialect, type CsvDialect } from "./dialect.ts";

type CsvFeature = FeaturesOf<typeof Csv>;

/**
 * When to quote fields, after Python's `csv.QUOTE_*`:
 * - `minimal`: only fields that need it (the default).
 * - `all`: every field.
 * - `nonNumeric`: every field except number cells.
 * - `none`: never. Writing fails if a field cannot be read back without quotes.
 */
export type CsvQuoting = "minimal" | "all" | "nonNumeric" | "none";

/** Options for the CSV writer. */
export interface CsvWriterOptions {
  /** The CSV dialect to render with (defaults to StandardDialect). */
  readonly dialect?: CsvDialect | undefined;
  /** When to quote fields (defaults to `minimal`). */
  readonly quoting?: CsvQuoting | undefined;
  /** Render number cells (defaults to {@link formatCsvNumber}). */
  readonly formatNumber?: ((value: number) => string) | undefined;
  /**
   * Escape a wrapper inside a quoted field with this character instead of
   * doubling it, as Python's `escapechar` with `doublequote=False` does:
   * `"say \"hi\""`. Unset (the default), the wrapper is doubled as RFC 4180
   * specifies.
   *
   * It fails closed: a field that holds the escape character itself fails
   * the write, since readers disagree on what it means there, and
   * `quoting: "none"` still fails on a field that needs quotes rather than
   * escaping its separators or line breaks (which a reader without the
   * escape character would split into new fields or rows). It must be one
   * character other than the separator, the wrapper or a line break; anything
   * else fails the write. The CSV reader has no escape-character option yet.
   */
  readonly escapeChar?: string | undefined;
  /**
   * Quote fields that start with this marker, so a reader with the same
   * `lineCommentMarker` doesn't skip their row as a comment.
   */
  readonly lineCommentMarker?: string | undefined;
  /**
   * Guard against CSV (formula) injection: prefix `'` to non-number fields that
   * start with `=`, `+`, `-`, `@`, a tab or a CR, and quote them. Spreadsheet
   * apps run such fields as formulas when the file is opened (for example
   * `=HYPERLINK(...)`), so set this when writing untrusted data that people will
   * open in Excel, Numbers or Google Sheets. It changes the values, so leave it
   * off for files read by programs. Off by default.
   */
  readonly escapeFormulae?: boolean | undefined;
  /** Start the output with a byte order mark, which Excel needs to detect UTF-8. */
  readonly bom?: boolean | undefined;
  /** A header row to write before the worksheet's rows. */
  readonly headers?: ReadonlyArray<string> | undefined;
  /**
   * Pad short rows with empty fields. A table is padded to its widest row; a
   * stream to the header row, or to its first row without headers.
   */
  readonly padRows?: boolean | undefined;
  /**
   * The most fields (counting one per line) a worksheet may expand to. A
   * worksheet is sparse and CSV is not: every gap between cells is written as
   * an empty field and every row the sheet does not hold as an empty line, so
   * one cell far out is a huge file. Past this the write fails with a
   * WriteError before rendering anything; a streamed row fails past it on its
   * own. Defaults to {@link DEFAULT_MAX_FIELDS}.
   */
  readonly maxFields?: number | undefined;
}

/** The default {@link CsvWriterOptions.maxFields}: core's dense-grid budget, five million. */
export const DEFAULT_MAX_FIELDS = DEFAULT_MAX_DENSE_CELLS;

// ============================================================================
// Field rendering
// ============================================================================

/**
 * Render a number as its shortest round-trip decimal, never in exponent form:
 * `1e21` renders as `1000000000000000000000`. `NaN` and the infinities render
 * as `String` does (`NaN`, `Infinity`, `-Infinity`), as pandas writes them;
 * they read back as text.
 */
export const formatCsvNumber = (value: number): string => {
  const s = String(value);
  const e = s.indexOf("e");
  if (e === -1) return s;
  const sign = value < 0 ? "-" : "";
  const [int = "", frac = ""] = s.slice(sign.length, e).split(".");
  const digits = int + frac;
  // where the decimal point falls within `digits`
  const point = int.length + Number(s.slice(e + 1));
  if (point <= 0) return `${sign}0.${"0".repeat(-point)}${digits}`;
  if (point >= digits.length) return sign + digits + "0".repeat(point - digits.length);
  return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
};

/** A field to render, and whether it came from a number cell. */
interface Field {
  readonly value: string;
  readonly numeric: boolean;
}

/** The writer options that shape each row. */
type RowOptions = Omit<
  CsvWriterOptions,
  "dialect" | "formatNumber" | "bom" | "headers" | "padRows"
>;

const formulaStart = /^[=+\-@\t\r]/;
const edgeSpace = /^\s|\s$/;

/** Fields that can't be read back at all without quotes. */
const breaksSyntax = (value: string, dialect: CsvDialect): boolean =>
  value.includes(dialect.separator) ||
  (dialect.wrapper !== "" && value.includes(dialect.wrapper)) ||
  value.includes("\n") ||
  value.includes("\r");

/** Fields that read back changed without quotes, by a reader that trims or skips comments. */
const changesMeaning = (value: string, options: RowOptions): boolean =>
  edgeSpace.test(value) ||
  (!!options.lineCommentMarker && value.startsWith(options.lineCommentMarker));

const wrapField = (value: string, dialect: CsvDialect): string =>
  dialect.wrapper + value.replaceAll(dialect.wrapper, dialect.doubleWrapper) + dialect.wrapper;

/**
 * Quote a field, escaping the wrapper with `escape` if set, else doubling it.
 * The field never holds `escape` itself (`renderRow` rejects that).
 */
const quoteField = (value: string, dialect: CsvDialect, escape: Option.Option<string>): string =>
  Option.match(escape, {
    onNone: () => wrapField(value, dialect),
    onSome: (e) =>
      dialect.wrapper + value.replaceAll(dialect.wrapper, e + dialect.wrapper) + dialect.wrapper,
  });

/** Why `escapeChar` can't be used with this dialect, if it can't. */
const badEscape = (escape: string, dialect: CsvDialect): Option.Option<string> =>
  Array.from(escape).length !== 1
    ? Option.some("must be exactly one character")
    : escape === dialect.separator ||
        escape === dialect.wrapper ||
        escape === "\n" ||
        escape === "\r"
      ? Option.some("must differ from the separator, the wrapper and line breaks")
      : Option.none();

/** Render a single field, quoting it if necessary (as the `minimal` mode does). */
export const renderField = (value: string, dialect: CsvDialect): string =>
  breaksSyntax(value, dialect) || edgeSpace.test(value) ? wrapField(value, dialect) : value;

const unquotable = (row: number, reason: string): WriteError =>
  new WriteError({
    format: "csv",
    reason: `Row ${row} ${reason} and cannot be written without quoting`,
  });

/** Whether a field must be quoted under a quoting mode other than `none`. */
const needsQuotes = (
  value: string,
  numeric: boolean,
  formula: boolean,
  dialect: CsvDialect,
  options: RowOptions,
): boolean =>
  options.quoting === "all" ||
  (options.quoting === "nonNumeric" && !numeric) ||
  formula ||
  breaksSyntax(value, dialect) ||
  changesMeaning(value, options);

/** Render one field of row `index`, or the error that stops the row. */
const renderOneField = (
  { value: raw, numeric }: Field,
  index: number,
  dialect: CsvDialect,
  options: RowOptions,
  escapeChar: Option.Option<string>,
): Result.Result<string, WriteError> => {
  const formula = !!options.escapeFormulae && !numeric && formulaStart.test(raw);
  const value = formula ? `'${raw}` : raw;
  if (Option.exists(escapeChar, (e) => value.includes(e)))
    return Result.fail(
      new WriteError({
        format: "csv",
        reason: `Row ${index} has a field holding the escape character, which cannot be written unambiguously`,
      }),
    );
  if (options.quoting === "none")
    return breaksSyntax(value, dialect)
      ? Result.fail(unquotable(index, "has a field that needs quotes"))
      : Result.succeed(value);
  return Result.succeed(
    needsQuotes(value, numeric, formula, dialect, options)
      ? quoteField(value, dialect, escapeChar)
      : value,
  );
};

/** Render one row, without its line break. `index` numbers it in errors. */
const renderRow = (
  fields: ReadonlyArray<Field>,
  index: number,
  dialect: CsvDialect,
  options: RowOptions,
): Effect.Effect<string, WriteError> => {
  const escapeChar = Option.fromNullishOr(options.escapeChar);
  // a lone empty field would be an empty line, which readers skip
  if (fields.length === 1 && fields[0]!.value === "") {
    if (options.quoting === "none")
      return Effect.fail(unquotable(index, "is a single empty field"));
    return Effect.succeed(wrapField("", dialect));
  }
  const out: Array<string> = [];
  for (const field of fields) {
    const rendered = renderOneField(field, index, dialect, options, escapeChar);
    if (Result.isFailure(rendered)) return Effect.fail(rendered.failure);
    out.push(rendered.success);
  }
  return Effect.succeed(out.join(dialect.separator));
};

const textFields = (values: ReadonlyArray<string>): ReadonlyArray<Field> =>
  values.map((value) => ({ value, numeric: false }));

const pad = (fields: ReadonlyArray<Field>, width: number): ReadonlyArray<Field> =>
  fields.length >= width
    ? fields
    : [
        ...fields,
        ...Array.from({ length: width - fields.length }, () => ({ value: "", numeric: false })),
      ];

const EMPTY_FIELD: Field = { value: "", numeric: false };

/**
 * A sparse row's fields from column 0 to its last cell, each gap the shared
 * empty field (no cell is allocated for it).
 */
const rowFields = (row: SheetRow, options: CsvWriterOptions): ReadonlyArray<Field> => {
  const format = options.formatNumber ?? formatCsvNumber;
  // The cells are in ascending column order, so one cursor walks them.
  let next = 0;
  return Array.from({ length: (row.cells.at(-1)?.col ?? -1) + 1 }, (_, col) => {
    const entry = row.cells[next];
    if (entry?.col !== col) return EMPTY_FIELD;
    next += 1;
    return Predicate.isTagged(entry.cell, "CellNumber")
      ? { value: format(entry.cell.value), numeric: true }
      : { value: cellToText(entry.cell), numeric: false };
  });
};

const tooManyFields = (fields: number, max: number) =>
  new WriteError({
    format: "csv",
    reason:
      `the worksheet expands to ${fields} fields with its gaps written out, ` +
      `more than the ${max}-field limit (maxFields)`,
  });

/** A worksheet's lines, one per row from 0 to its last, within the field budget. */
const sheetFields = (
  ws: Worksheet,
  options: CsvWriterOptions,
): Result.Result<ReadonlyArray<ReadonlyArray<Field>>, WriteError> => {
  const max = options.maxFields ?? DEFAULT_MAX_FIELDS;
  const fields = denseSize(ws, { rectangular: options.padRows ?? false });
  if (fields > max) return Result.fail(tooManyFields(fields, max));
  // The rows are in ascending index order, so one cursor walks them.
  let next = 0;
  return Result.succeed(
    Array.from({ length: sheetExtent(ws).rows }, (_, index) => {
      const row = ws.rows[next];
      if (row?.index !== index) return [];
      next += 1;
      return rowFields(row, options);
    }),
  );
};

/** Fail when the options can't be used with the dialect. */
const checkOptions = (
  options: CsvWriterOptions,
  dialect: CsvDialect,
): Effect.Effect<void, WriteError> => {
  const reason = Option.flatMap(Option.fromNullishOr(options.escapeChar), (e) =>
    badEscape(e, dialect),
  );
  return Option.match(reason, {
    onNone: () => Effect.void,
    onSome: (r) => Effect.fail(new WriteError({ format: "csv", reason: `escapeChar ${r}` })),
  });
};

/** Render rows of fields, with the header row, padding and BOM the options ask for. */
const renderRows = (
  body: ReadonlyArray<ReadonlyArray<Field>>,
  options: CsvWriterOptions,
): Effect.Effect<string, WriteError> =>
  Effect.gen(function* () {
    const dialect = options.dialect ?? StandardDialect;
    yield* checkOptions(options, dialect);
    const rows = options.headers ? [textFields(options.headers), ...body] : body;
    const width = options.padRows ? Math.max(0, ...rows.map((r) => r.length)) : 0;
    const lines = yield* Effect.forEach(
      rows,
      (row, i) => renderRow(pad(row, width), i, dialect, options),
      { concurrency: 1 },
    );
    return (options.bom ? "﻿" : "") + lines.map((line) => line + dialect.linebreak).join("");
  });

/** Render rows of string fields to CSV text (with trailing newline). */
export const renderTable = (
  rows: ReadonlyArray<ReadonlyArray<string>>,
  dialect: CsvDialect = StandardDialect,
): string =>
  rows
    .map((row) =>
      row.length === 1 && row[0] === ""
        ? wrapField("", dialect)
        : row.map((f) => renderField(f, dialect)).join(dialect.separator),
    )
    .join(dialect.linebreak) + (Arr.isReadonlyArrayNonEmpty(rows) ? dialect.linebreak : "");

/** Where a streamed render is: the next row's index and the width rows are padded to. */
interface RowState {
  readonly index: number;
  readonly width: number | null;
}

/**
 * Render a stream of worksheet rows to CSV text, one chunk per row (the BOM
 * and header row, if any, come first). Each row is written from column 0 to
 * its last cell, each gap an empty field (a row wider than `maxFields` fails); rows go out in stream order, so a row's `index` is not
 * read and no line is written for a row the stream skips. Chunks concatenate
 * to what `write` produces for the same consecutive rows, except that
 * `padRows` pads each row to the header row, or to the first row without
 * headers.
 */
export const renderCsvStream = <E, R>(
  rows: Stream.Stream<SheetRow, E, R>,
  options: CsvWriterOptions = {},
): Stream.Stream<string, E | WriteError, R> => {
  const dialect = options.dialect ?? StandardDialect;
  const headers = options.headers;
  const start = headers ? 1 : 0;
  const body = Stream.mapAccumEffect(
    rows,
    (): RowState => ({ index: start, width: headers?.length ?? null }),
    (state, row) => {
      const max = options.maxFields ?? DEFAULT_MAX_FIELDS;
      const rowWidth = (row.cells.at(-1)?.col ?? -1) + 1;
      if (rowWidth > max) return Effect.fail(tooManyFields(rowWidth, max));
      const fields = rowFields(row, options);
      const width = state.width ?? fields.length;
      return Effect.map(
        renderRow(options.padRows ? pad(fields, width) : fields, state.index, dialect, options),
        (line) => [{ index: state.index + 1, width }, [line + dialect.linebreak]] as const,
      );
    },
  );
  const head = headers
    ? Stream.fromEffect(renderRow(textFields(headers), 0, dialect, options)).pipe(
        Stream.map((line) => line + dialect.linebreak),
      )
    : Stream.empty;
  const all = Stream.concat(options.bom ? Stream.concat(Stream.make("﻿"), head) : head, body);
  // invalid options fail the stream before its first chunk
  return Stream.unwrap(Effect.as(checkOptions(options, dialect), all));
};

// ============================================================================
// Writer
// ============================================================================

/** Create a CSV Writer with the given options baked in. */
export const makeCsvWriter = (options?: CsvWriterOptions): Writer<CsvFeature> => {
  const opts = options ?? {};

  const write = (doc: Doc<CsvFeature>): Effect.Effect<Content, WriteError> =>
    Effect.suspend(() => {
      const ws = doc.blocks.find((b): b is Worksheet => Predicate.isTagged(b, "Worksheet"));
      // one line per row from the first to the last, each up to its own last
      // cell; a row the sheet does not hold is an empty line
      const rows = ws === undefined ? Result.succeed([]) : sheetFields(ws, opts);
      if (Result.isFailure(rows)) return Effect.fail(rows.failure);
      return Effect.map(renderRows(rows.success, opts), text);
    });

  return { format: "csv", profile: Csv, write };
};

/** Context tag for dependency-injection style usage. */
export const CsvWriterTag = makeWriterTag<CsvFeature>("csv");

/** Layer providing a CSV Writer with default options. */
export const CsvWriterLive = Layer.succeed(CsvWriterTag, makeCsvWriter());

/** Layer providing a CSV Writer with custom options. */
export const makeCsvWriterLayer = (options?: CsvWriterOptions) =>
  Layer.succeed(CsvWriterTag, makeCsvWriter(options));
