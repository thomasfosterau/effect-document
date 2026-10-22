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

import { Effect, Layer, Stream } from "effect";
import {
  cellToText, type Content, type Doc, type FeaturesOf, makeWriterTag, type SheetCell, type SheetRow,
  text, type Worksheet, WriteError, type Writer,
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

export interface CsvWriterOptions {
  /** The CSV dialect to render with (defaults to StandardDialect). */
  readonly dialect?: CsvDialect | undefined;
  /** When to quote fields (defaults to `minimal`). */
  readonly quoting?: CsvQuoting | undefined;
  /** Render number cells (defaults to {@link formatCsvNumber}). */
  readonly formatNumber?: (value: number) => string;
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
}

// ============================================================================
// Field rendering
// ============================================================================

/**
 * Render a number as its shortest round-trip decimal, never in exponent form:
 * `1e21` renders as `1000000000000000000000`. `NaN` and the infinities render
 * as `String` does.
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
type RowOptions = Omit<CsvWriterOptions, "dialect" | "formatNumber" | "bom" | "headers" | "padRows">;

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
  edgeSpace.test(value) || (!!options.lineCommentMarker && value.startsWith(options.lineCommentMarker));

const wrapField = (value: string, dialect: CsvDialect): string =>
  dialect.wrapper + value.replaceAll(dialect.wrapper, dialect.doubleWrapper) + dialect.wrapper;

/** Render a single field, quoting it if necessary (as the `minimal` mode does). */
export const renderField = (value: string, dialect: CsvDialect): string =>
  breaksSyntax(value, dialect) || edgeSpace.test(value) ? wrapField(value, dialect) : value;

const unquotable = (row: number, reason: string): WriteError =>
  new WriteError({ format: "csv", reason: `Row ${row} ${reason} and cannot be written without quoting` });

/** Render one row, without its line break. `index` numbers it in errors. */
const renderRow = (
  fields: ReadonlyArray<Field>,
  index: number,
  dialect: CsvDialect,
  options: RowOptions
): Effect.Effect<string, WriteError> => {
  const quoting = options.quoting ?? "minimal";
  // a lone empty field would be an empty line, which readers skip
  if (fields.length === 1 && fields[0]!.value === "") {
    if (quoting === "none") return Effect.fail(unquotable(index, "is a single empty field"));
    return Effect.succeed(wrapField("", dialect));
  }
  const out: Array<string> = [];
  for (const { value: raw, numeric } of fields) {
    const escape = !!options.escapeFormulae && !numeric && formulaStart.test(raw);
    const value = escape ? `'${raw}` : raw;
    if (quoting === "none") {
      if (breaksSyntax(value, dialect)) return Effect.fail(unquotable(index, "has a field that needs quotes"));
      out.push(value);
    } else if (
      quoting === "all" ||
      (quoting === "nonNumeric" && !numeric) ||
      escape ||
      breaksSyntax(value, dialect) ||
      changesMeaning(value, options)
    ) {
      out.push(wrapField(value, dialect));
    } else {
      out.push(value);
    }
  }
  return Effect.succeed(out.join(dialect.separator));
};

const textFields = (values: ReadonlyArray<string>): ReadonlyArray<Field> =>
  values.map((value) => ({ value, numeric: false }));

const pad = (fields: ReadonlyArray<Field>, width: number): ReadonlyArray<Field> =>
  fields.length >= width
    ? fields
    : [...fields, ...Array.from({ length: width - fields.length }, () => ({ value: "", numeric: false }))];

const cellFields = (cells: ReadonlyArray<SheetCell>, options: CsvWriterOptions): ReadonlyArray<Field> => {
  const format = options.formatNumber ?? formatCsvNumber;
  return cells.map((c) =>
    c._tag === "CellNumber" ? { value: format(c.value), numeric: true } : { value: cellToText(c), numeric: false }
  );
};

/** Render rows of fields, with the header row, padding and BOM the options ask for. */
const renderRows = (
  body: ReadonlyArray<ReadonlyArray<Field>>,
  options: CsvWriterOptions
): Effect.Effect<string, WriteError> =>
  Effect.gen(function* () {
    const dialect = options.dialect ?? StandardDialect;
    const rows = options.headers ? [textFields(options.headers), ...body] : body;
    const width = options.padRows ? Math.max(0, ...rows.map((r) => r.length)) : 0;
    let out = options.bom ? "﻿" : "";
    for (let i = 0; i < rows.length; i++) {
      out += (yield* renderRow(pad(rows[i]!, width), i, dialect, options)) + dialect.linebreak;
    }
    return out;
  });

/** Render rows of string fields to CSV text (with trailing newline). */
export const renderTable = (
  rows: ReadonlyArray<ReadonlyArray<string>>,
  dialect: CsvDialect = StandardDialect
): string =>
  rows.map((row) =>
    row.length === 1 && row[0] === ""
      ? wrapField("", dialect)
      : row.map((f) => renderField(f, dialect)).join(dialect.separator)
  ).join(dialect.linebreak) + (rows.length > 0 ? dialect.linebreak : "");

/**
 * Render a stream of worksheet rows to CSV text, one chunk per row (the BOM
 * and header row, if any, come first). Chunks concatenate to what `write`
 * produces for the same rows, except that `padRows` pads each row to the
 * header row, or to the first row without headers.
 */
export const renderCsvStream = <E, R>(
  rows: Stream.Stream<SheetRow, E, R>,
  options: CsvWriterOptions = {}
): Stream.Stream<string, E | WriteError, R> => {
  const dialect = options.dialect ?? StandardDialect;
  const headers = options.headers;
  const start = headers ? 1 : 0;
  const body = Stream.mapAccumEffect(
    rows,
    () => ({ index: start, width: headers?.length ?? null as number | null }),
    (state, row) => {
      const fields = cellFields(row.cells, options);
      const width = state.width ?? fields.length;
      return Effect.map(
        renderRow(options.padRows ? pad(fields, width) : fields, state.index, dialect, options),
        (line) => [{ index: state.index + 1, width }, [line + dialect.linebreak]] as const
      );
    }
  );
  const head = headers
    ? Stream.fromEffect(renderRow(textFields(headers), 0, dialect, options)).pipe(
        Stream.map((line) => line + dialect.linebreak)
      )
    : Stream.empty;
  return Stream.concat(options.bom ? Stream.concat(Stream.make("﻿"), head) : head, body);
};

// ============================================================================
// Writer
// ============================================================================

/** Create a CSV Writer with the given options baked in. */
export const makeCsvWriter = (options?: CsvWriterOptions): Writer<CsvFeature> => {
  const opts = options ?? {};

  const write = (doc: Doc<CsvFeature>): Effect.Effect<Content, WriteError> =>
    Effect.suspend(() => {
      const ws = doc.blocks.find((b): b is Worksheet => b._tag === "Worksheet");
      const rows = ws === undefined ? [] : ws.rows.map((row) => cellFields(row.cells, opts));
      return Effect.map(renderRows(rows, opts), text);
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
