/**
 * The low-level CSV scanner: text -> rows of raw string fields.
 *
 * Handles quoting, escaped quotes, quoted line breaks, comments, row skipping,
 * whitespace trimming, and column-count validation, parameterized by dialect.
 * The grammar is built with `@thomasfosterau/effect-parse`, so the same parser
 * scans a whole string ({@link scanCsv}) or a stream of chunks as they arrive
 * ({@link scanCsvStream}).
 */

import * as Arr from "effect/Array";
import {
  ParseError as SyntaxError,
  ParserStream,
  Parser,
  Token,
} from "@thomasfosterau/effect-parse";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import { pipe } from "effect/Function";
import { ParseError } from "@thomasfosterau/effect-document";
import { StandardDialect, type CsvDialect } from "./dialect.ts";

/** How the scanner splits CSV text into rows: headers, row limits and the like (shared by the reader). */
export interface CsvScanOptions {
  /**
   * Treat the first row as column headers. If `providedHeaders` is also set,
   * the first row is dropped and `providedHeaders` replace it.
   */
  readonly treatFirstRowAsHeader?: boolean | undefined;
  /** Supply custom column headers. */
  readonly providedHeaders?: ReadonlyArray<string> | undefined;
  /**
   * Fail with a ParseError when the headers (from the first row or
   * `providedHeaders`) contain an empty or whitespace-only name, or the same
   * name twice. Off by default: such headers are common (pandas writes an
   * unnamed index column) and are kept as they are.
   */
  readonly validateHeaders?: boolean | undefined;
  /**
   * Physical lines to skip before scanning. Lines end at CRLF, LF or a bare CR,
   * and are counted without regard to quoting, so the skipped lines need not be
   * valid CSV.
   */
  readonly skipRows?: number | undefined;
  readonly filterEmpty?: boolean | undefined;
  /** Trim whitespace around fields. Whitespace inside quotes is kept. */
  readonly trimWhitespace?: boolean | undefined;
  /**
   * Allow rows of different widths. Otherwise every row must be as wide as the
   * headers, or as the first row when there are none.
   */
  readonly allowVariableColumns?: boolean | undefined;
  readonly lineCommentMarker?: string | undefined;
  /**
   * Let quoted segments start anywhere in a field, so `a"b,c"d` reads as
   * `ab,cd`. By default a field is quoted only if it starts with the wrapper,
   * and a wrapper anywhere else is a literal character: `12" pizza` stays
   * `12" pizza`.
   */
  readonly quoteAnywhere?: boolean | undefined;
}

/** The result of scanning CSV text: optional headers plus raw string rows */
export interface ScannedTable {
  readonly headers: ReadonlyArray<string> | null;
  readonly rows: ReadonlyArray<ReadonlyArray<string>>;
}

const defaults = (options?: CsvScanOptions): CsvScanOptions => ({
  treatFirstRowAsHeader: false,
  skipRows: 0,
  filterEmpty: true,
  trimWhitespace: false,
  allowVariableColumns: false,
  ...options,
});

// ============================================================================
// Grammar
// ============================================================================

/** A record terminator: CRLF, LF, or a bare CR. */
const lineEnding = Parser.alt(Token.literal("\r\n"), Token.literal("\n"), Token.literal("\r"));
const endOfLine = Parser.alt(Parser.asVoid(lineEnding), Parser.eof);
/** Horizontal whitespace, for blank and comment lines. */
const blanks = Token.takeWhile(" \t\f\v");

const concat = <E, R>(part: Parser.Parser<string, E, R>): Parser.Parser<string, E, R> =>
  Parser.fold(part, { init: () => "", f: (acc, s) => acc + s });

/**
 * A non-empty piece of text before the next separator or line break, also
 * stopping at any of `stops`. Multi-character separators are matched whole, so
 * a field may contain their characters.
 */
const makeTextPart = (separator: string, stops: string): Parser.Parser<string> => {
  const head = separator[0] ?? "";
  const run = Token.takeTill(head + "\r\n" + stops, { min: 1 });
  return separator.length > 1
    ? Parser.alt(run, Parser.preceded(Parser.not(Token.literal(separator)), Token.oneOf(head)))
    : run;
};

/** Text up to the next separator or line break, possibly empty. */
const makeText = (separator: string): Parser.Parser<string> => concat(makeTextPart(separator, ""));

/**
 * A quoted segment, without its wrappers. Inside quotes, `doubleWrapper` stands
 * for a literal wrapper and line breaks are part of the field. An unclosed
 * quote is a syntax error.
 */
const makeQuoted = ({ wrapper, doubleWrapper }: CsvDialect): Parser.Parser<string> => {
  const quote = Token.literal(wrapper);
  const run = Token.takeTill(wrapper[0]! + (doubleWrapper[0] ?? ""), { min: 1 });
  // a lone first character of a multi-character wrapper or escape
  const lone = Parser.preceded(Parser.not(quote), Token.any);
  const content =
    doubleWrapper === ""
      ? concat(Parser.alt(run, lone))
      : concat(Parser.alt(Parser.as(Token.literal(doubleWrapper), wrapper), run, lone));
  return Parser.preceded(
    quote,
    Parser.cut(
      Parser.terminated(
        content,
        Parser.alt(quote, Parser.failMessage("Unclosed quoted field: expected a closing quote")),
      ),
    ),
  ).pipe(Parser.context("quoted field"));
};

/** Whitespace that may be trimmed before a quoted field. */
const leadingSpace = (separator: string): Parser.Parser<string> =>
  Token.takeWhile([..." \t\f\v"].filter((c) => !separator.includes(c)).join(""));

/**
 * One field. A field that starts with the wrapper is quoted, and any text after
 * the closing quote is kept literally (`"a"b` reads as `ab`). Anywhere else the
 * wrapper is an ordinary character, unless `quoteAnywhere` is set. An empty
 * `wrapper` turns quoting off.
 */
const makeField = (dialect: CsvDialect, options: CsvScanOptions): Parser.Parser<string> => {
  const { separator, wrapper } = dialect;
  const trim = !!options.trimWhitespace;
  const trimmed = (field: Parser.Parser<string>) =>
    trim ? Parser.map(field, (f) => f.trim()) : field;
  if (wrapper === "") return trimmed(makeText(separator));
  const quoted = makeQuoted(dialect);
  if (options.quoteAnywhere) {
    // quoted and unquoted segments mix freely
    const unquoted = Parser.alt(
      makeTextPart(separator, wrapper[0]!),
      Parser.preceded(Parser.not(Token.literal(wrapper)), Token.oneOf(wrapper[0]!)),
    );
    return trimmed(concat(Parser.alt(quoted, unquoted)));
  }
  const text = makeText(separator);
  const quotedField = Parser.map(
    Parser.seq(quoted, text),
    ([value, rest]) => value + (trim ? rest.trimEnd() : rest),
  );
  if (!trim) return Parser.alt(quotedField, text);
  return Parser.preceded(leadingSpace(separator), Parser.alt(quotedField, trimmed(text)));
};

/**
 * One physical-or-logical row: a record (an array of fields) or `null` for a
 * skipped blank or comment line, followed by its line ending. Never matches at
 * the end of input, so it can be repeated or streamed.
 */
const makeRow = (
  dialect: CsvDialect,
  options: CsvScanOptions,
): Parser.Parser<ReadonlyArray<string> | null> => {
  const record: Parser.Parser<ReadonlyArray<string> | null> = Parser.separated(
    makeField(dialect, options),
    Token.literal(dialect.separator),
  );
  const skipped: Array<Parser.Parser<null>> = [];
  if (options.filterEmpty) {
    skipped.push(Parser.as(Parser.terminated(blanks, Parser.peek(endOfLine)), null));
  }
  if (options.lineCommentMarker) {
    skipped.push(
      Parser.as(
        Parser.seq(blanks, Token.literal(options.lineCommentMarker), Token.takeTill("\r\n")),
        null,
      ),
    );
  }
  return Parser.preceded(
    Parser.not(Parser.eof),
    Parser.terminated(Parser.alt(...skipped, record), endOfLine),
  );
};

/** Skip `n` physical lines, each ended by CRLF, LF or a bare CR. */
const skipLines = (n: number): Parser.Parser<unknown> =>
  Parser.repeat(Parser.seq(Token.takeTill("\r\n"), endOfLine), n);

/** A 0-based row and column in the source text. */
interface TextPosition {
  readonly row: number;
  readonly column: number;
}

/** The 0-based row and column of `offset`, counting CRLF, LF and bare CR as line breaks. */
const positionAt = (text: string, offset: number): TextPosition => {
  let row = 0;
  let lineStart = 0;
  for (let i = 0; i < offset; i++) {
    const c = text.charCodeAt(i);
    if (c === 10 || (c === 13 && text.charCodeAt(i + 1) !== 10)) {
      row++;
      lineStart = i + 1;
    }
  }
  return { row, column: offset - lineStart };
};

const lineBreaks = /\r\n?|\n/g;

/** Physical lines taken by a scanned row: one, plus any quoted line breaks. */
const linesIn = (row: ReadonlyArray<string> | null): number => {
  let n = 1;
  if (row !== null) {
    for (const field of row) n += field.match(lineBreaks)?.length ?? 0;
  }
  return n;
};

/**
 * Convert a grammar error. `firstRow` is the source row its input starts on:
 * stream errors are positioned within the buffer of unconsumed input, which
 * always starts at a row boundary.
 */
const fromSyntaxError = (e: SyntaxError.ParseError, firstRow: number): ParseError => {
  // SAFETY: every CSV grammar runs on string input, so its errors carry a string.
  const { row, column } = positionAt(e.input as string, e.offset);
  return new ParseError({
    format: "csv",
    reason: e.description ?? `expected ${SyntaxError.formatExpected(e.expected)}`,
    position: { row: firstRow + row, column },
    cause: e,
  });
};

const stripBom = (text: string): string => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);

// ============================================================================
// Headers and column validation
// ============================================================================

/** A scanned record and the source row it starts on. */
interface Located {
  readonly row: number;
  readonly fields: ReadonlyArray<string>;
}

const columnCountError = (row: number, actual: number, expected: number): ParseError =>
  new ParseError({
    format: "csv",
    reason: `Row ${row} has ${actual} columns, expected ${expected}`,
    position: { row },
  });

/**
 * Fail on the first empty (or whitespace-only) or repeated header name, at its
 * column; `row` is the header row's source row, when the headers came from one.
 */
const checkHeaders = (
  headers: ReadonlyArray<string>,
  row: number | undefined,
): Effect.Effect<void, ParseError> =>
  Option.match(
    Arr.findFirstWithIndex(headers, (name, i): Option.Option<string> => {
      if (name.trim() === "") return Option.some(`Header ${i + 1} is empty`);
      const first = headers.indexOf(name);
      return first < i
        ? Option.some(`Header "${name}" appears in columns ${first + 1} and ${i + 1}`)
        : Option.none();
    }),
    {
      onNone: () => Effect.void,
      onSome: ([reason, column]) =>
        Effect.fail(new ParseError({ format: "csv", reason, position: { row, column } })),
    },
  );

const splitHeaders = (
  records: ReadonlyArray<Located>,
  options: CsvScanOptions,
): Effect.Effect<ScannedTable, ParseError> => {
  if (Arr.isReadonlyArrayEmpty(records)) return Effect.succeed({ headers: null, rows: [] });
  const dropFirst = !!options.treatFirstRowAsHeader;
  const headers = options.providedHeaders ?? (dropFirst ? records[0]!.fields : null);
  const data = dropFirst ? records.slice(1) : records;
  const validated =
    options.validateHeaders && headers !== null
      ? checkHeaders(headers, options.providedHeaders ? undefined : records[0]?.row)
      : Effect.void;
  return Effect.flatMap(validated, () => splitRows(headers, data, options));
};

const splitRows = (
  headers: ReadonlyArray<string> | null,
  data: ReadonlyArray<Located>,
  options: CsvScanOptions,
): Effect.Effect<ScannedTable, ParseError> => {
  if (!options.allowVariableColumns) {
    const width = headers?.length ?? data[0]?.fields.length ?? 0;
    for (const { row, fields } of data) {
      if (fields.length !== width) return Effect.fail(columnCountError(row, fields.length, width));
    }
  }
  return Effect.succeed({ headers, rows: data.map((r) => r.fields) });
};

// ============================================================================
// Scanning
// ============================================================================

type TableParser = Parser.Parser<ReadonlyArray<readonly [number, ReadonlyArray<string> | null]>>;

/** Compiled whole-text grammars, keyed by everything that shapes them, least recently used first. */
const tableParsers = new Map<string, TableParser>();
const maxCachedParsers = 32;

const tableParser = (dialect: CsvDialect, options: CsvScanOptions): TableParser => {
  // NUL never appears in a dialect character or a comment marker, so joining
  // on it keys every distinct option set apart.
  const key = [
    dialect.separator,
    dialect.wrapper,
    dialect.doubleWrapper,
    options.skipRows ?? 0,
    !!options.filterEmpty,
    !!options.trimWhitespace,
    options.lineCommentMarker ?? "",
    !!options.quoteAnywhere,
  ].join("\u0000");
  let parser = tableParsers.get(key);
  if (parser === undefined) {
    parser = Parser.compile(
      Parser.preceded(
        skipLines(options.skipRows ?? 0),
        Parser.repeat(Parser.seq(Parser.location, makeRow(dialect, options))),
      ),
    );
    if (tableParsers.size >= maxCachedParsers)
      tableParsers.delete(tableParsers.keys().next().value!);
  } else {
    tableParsers.delete(key);
  }
  tableParsers.set(key, parser);
  return parser;
};

/**
 * Scan CSV text into headers and raw string rows. A leading byte order mark is
 * ignored.
 */
export const scanCsv = (
  text: string,
  dialect: CsvDialect = StandardDialect,
  options?: CsvScanOptions,
): Effect.Effect<ScannedTable, ParseError> => {
  const opts = defaults(options);
  const source = stripBom(text);
  const result = Parser.parse(tableParser(dialect, opts), source);
  if (Result.isFailure(result)) return Effect.fail(fromSyntaxError(result.failure, 0));
  const records: Array<Located> = [];
  for (const [offset, fields] of result.success) {
    if (fields === null) continue;
    // counted only when a column-count error reports it
    records.push({
      fields,
      get row() {
        return positionAt(source, offset).row;
      },
    });
  }
  return splitHeaders(records, opts);
};

interface HeaderState {
  /** Records seen so far, including the header row. */
  readonly index: number;
  readonly headers: ReadonlyArray<string> | null;
  /** The width every data row must have, once known. */
  readonly width: number | null;
}

/** Drop a leading byte order mark from a stream of text chunks. */
const dropBom = <E, R>(chunks: Stream.Stream<string, E, R>): Stream.Stream<string, E, R> =>
  Stream.mapAccum(
    chunks,
    () => true,
    (first, chunk) =>
      !first || chunk === "" ? ([first, [chunk]] as const) : ([false, [stripBom(chunk)]] as const),
  );

/**
 * Drop the first `n` physical lines (ended by CRLF, LF or a bare CR) from a
 * stream of text chunks. A CRLF may be split across chunks.
 */
const dropLines =
  <E, R>(n: number) =>
  (chunks: Stream.Stream<string, E, R>): Stream.Stream<string, E, R> =>
    n <= 0
      ? chunks
      : Stream.mapAccum(
          chunks,
          () => ({ remaining: n, afterCr: false }),
          (state, chunk) => {
            if (state.remaining === 0 && !state.afterCr) return [state, [chunk]] as const;
            if (chunk === "") return [state, []] as const;
            let remaining = state.remaining;
            let afterCr = false;
            // an LF just after a CR belongs to the same line break
            let i = state.afterCr && chunk.charCodeAt(0) === 10 ? 1 : 0;
            while (remaining > 0 && i < chunk.length) {
              const c = chunk.charCodeAt(i++);
              if (c === 10) {
                remaining--;
              } else if (c === 13) {
                remaining--;
                if (i === chunk.length) afterCr = true;
                else if (chunk.charCodeAt(i) === 10) i++;
              }
            }
            const rest = remaining > 0 ? "" : chunk.slice(i);
            return [{ remaining, afterCr }, rest === "" ? [] : [rest]] as const;
          },
        );

/**
 * Scan a stream of CSV text chunks into data rows, emitting each row as soon as
 * it is complete. Chunks may split fields, quotes and line endings anywhere.
 * With `treatFirstRowAsHeader`, the header row is used for column validation
 * and not emitted. A leading byte order mark is ignored.
 */
export const scanCsvStream = <E, R>(
  chunks: Stream.Stream<string, E, R>,
  dialect: CsvDialect = StandardDialect,
  options?: CsvScanOptions,
): Stream.Stream<ReadonlyArray<string>, E | ParseError, R> =>
  Stream.suspend(() => {
    const opts = defaults(options);
    const provided = opts.providedHeaders ?? null;
    const validated =
      opts.validateHeaders && provided !== null ? checkHeaders(provided, undefined) : Effect.void;
    // the source row the next scanned row starts on
    let nextRow = opts.skipRows ?? 0;
    const rows = pipe(
      chunks,
      dropBom,
      dropLines(opts.skipRows ?? 0),
      ParserStream.parseMany(makeRow(dialect, opts)),
      Stream.map((fields) => {
        const row = nextRow;
        nextRow += linesIn(fields);
        return { row, fields };
      }),
      Stream.mapError((e) => {
        if (SyntaxError.isParseError(e)) {
          // SAFETY: a grammar failure from this stream's own string parser
          return fromSyntaxError(e as SyntaxError.ParseError, nextRow);
        }
        // SAFETY: anything else is the input stream's own failure, `E`
        return e as E;
      }),
      Stream.filter((r): r is Located => r.fields !== null),
      Stream.mapAccumEffect(
        (): HeaderState => ({ index: 0, headers: provided, width: provided?.length ?? null }),
        (
          state,
          { row, fields },
        ): Effect.Effect<
          readonly [HeaderState, ReadonlyArray<ReadonlyArray<string>>],
          ParseError
        > => {
          const index = state.index + 1;
          if (opts.treatFirstRowAsHeader && state.index === 0) {
            const headers = state.headers ?? fields;
            const validated = opts.validateHeaders
              ? checkHeaders(headers, state.headers ? undefined : row)
              : Effect.void;
            return Effect.as(validated, [{ index, headers, width: headers.length }, []] as const);
          }
          const width = state.width ?? fields.length;
          if (!opts.allowVariableColumns && fields.length !== width) {
            return Effect.fail(columnCountError(row, fields.length, width));
          }
          return Effect.succeed([{ index, headers: state.headers, width }, [fields]] as const);
        },
      ),
    );
    return Stream.concat(Stream.fromEffectDrain(validated), rows);
  });
