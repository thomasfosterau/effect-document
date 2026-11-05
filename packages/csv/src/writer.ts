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
import * as Stream from "effect/Stream";
import {
  type CellNumber,
  cellToText,
  type Content,
  DEFAULT_MAX_DENSE_CELLS,
  denseSize,
  type Doc,
  type FeaturesOf,
  type IndexedCell,
  makeWriterTag,
  type SheetCell,
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

/** The writer options that shape each row. */
type RowOptions = Omit<
  CsvWriterOptions,
  "dialect" | "formatNumber" | "bom" | "headers" | "padRows"
>;

/** Whether a character code is one `\s` matches in a regular expression. */
const isSpace = (c: number): boolean =>
  c === 32 ||
  (c >= 9 && c <= 13) ||
  (c >= 0xa0 &&
    (c === 0xa0 ||
      c === 0x1680 ||
      (c >= 0x2000 && c <= 0x200a) ||
      c === 0x2028 ||
      c === 0x2029 ||
      c === 0x202f ||
      c === 0x205f ||
      c === 0x3000 ||
      c === 0xfeff));

/** Whether a field starts or ends with whitespace (`/^\s|\s$/`), which a trimming reader drops. */
const hasEdgeSpace = (value: string): boolean =>
  value !== "" && (isSpace(value.charCodeAt(0)) || isSpace(value.charCodeAt(value.length - 1)));

/** Whether a field starts as a formula does (`=`, `+`, `-`, `@`, a tab or a CR). */
const startsFormula = (value: string): boolean => {
  const c = value.charCodeAt(0);
  return c === 61 || c === 43 || c === 45 || c === 64 || c === 9 || c === 13;
};

/** Fields that can't be read back at all without quotes. */
const breaksSyntax = (value: string, dialect: CsvDialect): boolean =>
  value.includes(dialect.separator) ||
  (dialect.wrapper !== "" && value.includes(dialect.wrapper)) ||
  value.includes("\n") ||
  value.includes("\r");

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * {@link breaksSyntax} as one test, for a whole write: a single native scan
 * of each field rather than four. An empty separator is in every field.
 */
const syntaxTest = (dialect: CsvDialect): ((value: string) => boolean) => {
  if (dialect.separator === "") return () => true;
  const pattern = new RegExp(
    [dialect.separator, dialect.wrapper, "\n", "\r"]
      .filter((s) => s !== "")
      .map(escapeRegExp)
      .join("|"),
  );
  return (value) => pattern.test(value);
};

/** Fields that read back changed without quotes, by a reader that trims or skips comments. */
const changesMeaning = (value: string, options: RowOptions): boolean =>
  hasEdgeSpace(value) ||
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
  breaksSyntax(value, dialect) || hasEdgeSpace(value) ? wrapField(value, dialect) : value;

const unquotable = (row: number, reason: string): WriteError =>
  new WriteError({
    format: "csv",
    reason: `Row ${row} ${reason} and cannot be written without quoting`,
  });

/**
 * Everything that shapes how a field is rendered, resolved once per write
 * rather than once per field.
 */
interface RowContext {
  readonly dialect: CsvDialect;
  /** {@link breaksSyntax} for `dialect`. */
  readonly breaks: (value: string) => boolean;
  readonly options: RowOptions;
  readonly escapeChar: Option.Option<string>;
  readonly formatNumber: (value: number) => string;
}

const rowContext = (options: CsvWriterOptions): RowContext => ({
  dialect: options.dialect ?? StandardDialect,
  breaks: syntaxTest(options.dialect ?? StandardDialect),
  options,
  escapeChar: Option.fromNullishOr(options.escapeChar),
  formatNumber: options.formatNumber ?? formatCsvNumber,
});

/** Whether a field must be quoted under a quoting mode other than `none`. */
const needsQuotes = (
  value: string,
  numeric: boolean,
  formula: boolean,
  { breaks, options }: RowContext,
): boolean =>
  options.quoting === "all" ||
  (options.quoting === "nonNumeric" && !numeric) ||
  formula ||
  breaks(value) ||
  changesMeaning(value, options);

/**
 * Render one field of row `index`, or the error that stops the row. A plain
 * string or a `WriteError`, so the common case allocates nothing but the
 * field.
 */
const renderOneField = (
  raw: string,
  numeric: boolean,
  index: number,
  ctx: RowContext,
): string | WriteError => {
  const { dialect, options, escapeChar, breaks } = ctx;
  const formula = !!options.escapeFormulae && !numeric && startsFormula(raw);
  const value = formula ? `'${raw}` : raw;
  if (Option.isSome(escapeChar) && value.includes(escapeChar.value))
    return new WriteError({
      format: "csv",
      reason: `Row ${index} has a field holding the escape character, which cannot be written unambiguously`,
    });
  if (options.quoting === "none")
    return breaks(value) ? unquotable(index, "has a field that needs quotes") : value;
  return needsQuotes(value, numeric, formula, ctx) ? quoteField(value, dialect, escapeChar) : value;
};

/** A row of exactly one empty field, which unquoted would be an empty line readers skip. */
const loneEmptyField = (index: number, ctx: RowContext): string | WriteError =>
  ctx.options.quoting === "none"
    ? unquotable(index, "is a single empty field")
    : wrapField("", ctx.dialect);

/**
 * Render row `index` from header strings, without its line break, padded
 * with empty fields to `width`.
 */
const renderTextRow = (
  values: ReadonlyArray<string>,
  index: number,
  width: number,
  ctx: RowContext,
): string | WriteError => {
  const n = Math.max(values.length, width);
  if (n === 1 && (values[0] ?? "") === "") return loneEmptyField(index, ctx);
  let line = "";
  // oxlint-disable-next-line effect/imperative-loops -- once per field written, as in `renderSheetRow`
  for (let col = 0; col < n; col++) {
    const field = renderOneField(values[col] ?? "", false, index, ctx);
    if (!Predicate.isString(field)) return field;
    line = col === 0 ? field : line + ctx.dialect.separator + field;
  }
  return line;
};

/** One past a sparse row's last column: the number of fields it is written as. */
const rowWidth = (cells: ReadonlyArray<IndexedCell>): number => (cells.at(-1)?.col ?? -1) + 1;

/**
 * Render row `index` from a sparse sheet row's cells (none, for a row the
 * sheet does not hold), without its line break: a field per column from 0 to
 * its last cell, each gap an empty field, then empty fields to `width`.
 */
const renderSheetRow = (
  cells: ReadonlyArray<IndexedCell>,
  index: number,
  width: number,
  ctx: RowContext,
): string | WriteError => {
  const n = Math.max(rowWidth(cells), width);
  const only = cells[0];
  if (n === 1 && (only === undefined || cellField(only.cell, ctx) === "")) {
    return loneEmptyField(index, ctx);
  }
  let line = "";
  // the cells are in ascending column order, so one cursor walks them
  let next = 0;
  // oxlint-disable-next-line effect/imperative-loops -- once per field written: the measured hot path (bench/csv.bench.ts), where a Field object and a Result per field cost most of the write
  for (let col = 0; col < n; col++) {
    const entry = cells[next];
    const held = entry?.col === col;
    if (held) next++;
    const field = held
      ? renderOneField(cellField(entry.cell, ctx), isNumberCell(entry.cell), index, ctx)
      : renderOneField("", false, index, ctx);
    if (!Predicate.isString(field)) return field;
    line = col === 0 ? field : line + ctx.dialect.separator + field;
  }
  return line;
};

const isNumberCell = (c: SheetCell): c is CellNumber => Predicate.isTagged(c, "CellNumber");

/** A cell's field before quoting: a number in the write's number format, anything else its text. */
const cellField = (c: SheetCell, ctx: RowContext): string =>
  isNumberCell(c) ? ctx.formatNumber(c.value) : cellToText(c);

const tooManyFields = (fields: number, max: number) =>
  new WriteError({
    format: "csv",
    reason:
      `the worksheet expands to ${fields} fields with its gaps written out, ` +
      `more than the ${max}-field limit (maxFields)`,
  });

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

/**
 * Render a worksheet (or none) to CSV text: one line per row from 0 to its
 * last, after the BOM and header row the options ask for, within the field
 * budget.
 */
const renderSheet = (
  ws: Option.Option<Worksheet>,
  options: CsvWriterOptions,
): Effect.Effect<string, WriteError> =>
  Effect.suspend(() => {
    const ctx = rowContext(options);
    const { dialect } = ctx;
    const max = options.maxFields ?? DEFAULT_MAX_FIELDS;
    const fields = Option.match(ws, {
      onNone: () => 0,
      onSome: (sheet) => denseSize(sheet, { rectangular: options.padRows ?? false }),
    });
    if (fields > max) return Effect.fail(tooManyFields(fields, max));
    return Effect.flatMap(checkOptions(options, dialect), () => {
      const headers = options.headers;
      const rows = Option.match(ws, { onNone: () => [], onSome: (sheet) => sheet.rows });
      // a loop, not `Math.max(...widths)`: a spread of every row overflows
      // the stack on a large sheet
      let width = 0;
      if (options.padRows) {
        width = headers?.length ?? 0;
        width = rows.reduce((w, row) => Math.max(w, rowWidth(row.cells)), width);
      }
      const lines: Array<string> = [];
      if (headers) {
        const line = renderTextRow(headers, 0, width, ctx);
        if (!Predicate.isString(line)) return Effect.fail(line);
        lines.push(line);
      }
      const first = headers ? 1 : 0;
      const count = Option.match(ws, {
        onNone: () => 0,
        onSome: (sheet) => sheetExtent(sheet).rows,
      });
      // the rows are in ascending index order, so one cursor walks them
      let next = 0;
      // oxlint-disable-next-line effect/imperative-loops -- once per row written, beside the field loop in `renderSheetRow`; it stops at the first row that fails
      for (let index = 0; index < count; index++) {
        const row = rows[next];
        const held = row?.index === index;
        if (held) next++;
        const line = renderSheetRow(held ? row.cells : [], first + index, width, ctx);
        if (!Predicate.isString(line)) return Effect.fail(line);
        lines.push(line);
      }
      const body = Arr.isReadonlyArrayNonEmpty(lines)
        ? lines.join(dialect.linebreak) + dialect.linebreak
        : "";
      return Effect.succeed((options.bom ? "\ufeff" : "") + body);
    });
  });

/** Render rows of string fields to CSV text (with trailing newline). */
export const renderTable = (
  rows: ReadonlyArray<ReadonlyArray<string>>,
  dialect: CsvDialect = StandardDialect,
): string => {
  const breaks = syntaxTest(dialect);
  const lines = rows.map((row) => {
    if (row.length === 1 && row[0] === "") return wrapField("", dialect);
    let line = "";
    let first = true;
    // oxlint-disable-next-line effect/imperative-loops -- once per field written, as in `renderSheetRow`
    for (const value of row) {
      const field = breaks(value) || hasEdgeSpace(value) ? wrapField(value, dialect) : value;
      line = first ? field : line + dialect.separator + field;
      first = false;
    }
    return line;
  });
  return Arr.isReadonlyArrayNonEmpty(rows) ? lines.join(dialect.linebreak) + dialect.linebreak : "";
};

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
  const ctx = rowContext(options);
  const { dialect } = ctx;
  const headers = options.headers;
  const start = headers ? 1 : 0;
  const body = Stream.mapAccumEffect(
    rows,
    (): RowState => ({ index: start, width: headers?.length ?? null }),
    (state, row) => {
      const max = options.maxFields ?? DEFAULT_MAX_FIELDS;
      const fields = rowWidth(row.cells);
      if (fields > max) return Effect.fail(tooManyFields(fields, max));
      const width = state.width ?? fields;
      const line = renderSheetRow(row.cells, state.index, options.padRows ? width : 0, ctx);
      return Predicate.isString(line)
        ? Effect.succeed([{ index: state.index + 1, width }, [line + dialect.linebreak]] as const)
        : Effect.fail(line);
    },
  );
  const head = headers
    ? Stream.fromEffect(
        Effect.suspend(() => {
          const line = renderTextRow(headers, 0, 0, ctx);
          return Predicate.isString(line)
            ? Effect.succeed(line + dialect.linebreak)
            : Effect.fail(line);
        }),
      )
    : Stream.empty;
  const all = Stream.concat(options.bom ? Stream.concat(Stream.make("\ufeff"), head) : head, body);
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
      return Effect.map(renderSheet(Option.fromNullishOr(ws), opts), text);
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
