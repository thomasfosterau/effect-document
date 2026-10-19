/**
 * The low-level CSV scanner: text -> rows of raw string fields.
 *
 * Handles quoting, escaped quotes, quoted line breaks, comments, row skipping,
 * whitespace trimming, and column-count validation, parameterized by dialect.
 * The grammar is built with `@thomasfosterau/effect-parse`, so the same parser
 * scans a whole string ({@link scanCsv}) or a stream of chunks as they arrive
 * ({@link scanCsvStream}).
 */

import {
  ParseError as SyntaxError, ParserStream, Parser, Token,
} from "@thomasfosterau/effect-parse";
import { Effect, Result, Stream, pipe } from "effect";
import { ParseError } from "../../io/errors.js";
import { StandardDialect, type CsvDialect } from "./dialect.js";

export interface CsvScanOptions {
  /**
   * Treat the first row as column headers.
   * Note: If both treatFirstRowAsHeader and providedHeaders are set,
   * treatFirstRowAsHeader takes precedence and providedHeaders is ignored.
   */
  readonly treatFirstRowAsHeader?: boolean;
  /**
   * Supply custom column headers (ignored if treatFirstRowAsHeader is true)
   */
  readonly providedHeaders?: ReadonlyArray<string>;
  /** Physical lines to skip before scanning. */
  readonly skipRows?: number;
  readonly filterEmpty?: boolean;
  readonly trimWhitespace?: boolean;
  readonly allowVariableColumns?: boolean;
  readonly lineCommentMarker?: string;
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
 * One field: any mix of quoted and unquoted segments, so `a"b,c"d` reads as
 * `ab,cd`. Inside quotes, `doubleWrapper` stands for a literal wrapper and line
 * breaks are part of the field. An unclosed quote is a syntax error.
 */
const makeField = (dialect: CsvDialect): Parser.Parser<string> => {
  const { separator, wrapper, doubleWrapper } = dialect;
  const quote = Token.literal(wrapper);
  const quoted = Parser.preceded(
    quote,
    Parser.cut(
      Parser.terminated(
        concat(
          Parser.alt(
            Parser.as(Token.literal(doubleWrapper), wrapper),
            Token.takeTill(wrapper[0]! + doubleWrapper[0]!, { min: 1 }),
            // a lone first character of a multi-character wrapper or escape
            Parser.preceded(Parser.not(quote), Token.any)
          )
        ),
        Parser.expected(quote, "closing quote")
      )
    )
  ).pipe(Parser.context("quoted field"));
  const unquoted = Parser.alt(
    Token.takeTill(separator + "\r\n" + wrapper[0]!, { min: 1 }),
    Parser.preceded(Parser.not(quote), Token.oneOf(wrapper[0]!))
  );
  return concat(Parser.alt(quoted, unquoted));
};

/**
 * One physical-or-logical row: a record (an array of fields) or `null` for a
 * skipped blank or comment line, followed by its line ending. Never matches at
 * the end of input, so it can be repeated or streamed.
 */
const makeRow = (
  dialect: CsvDialect,
  options: CsvScanOptions
): Parser.Parser<ReadonlyArray<string> | null> => {
  const field = options.trimWhitespace
    ? Parser.map(makeField(dialect), (f) => f.trim())
    : makeField(dialect);
  const record: Parser.Parser<ReadonlyArray<string> | null> = Parser.separated(
    field,
    Token.literal(dialect.separator)
  );
  const skipped: Array<Parser.Parser<null>> = [];
  if (options.filterEmpty) {
    skipped.push(Parser.as(Parser.terminated(blanks, Parser.peek(endOfLine)), null));
  }
  if (options.lineCommentMarker) {
    skipped.push(
      Parser.as(
        Parser.seq(blanks, Token.literal(options.lineCommentMarker), Token.takeTill("\r\n")),
        null
      )
    );
  }
  return Parser.preceded(
    Parser.not(Parser.eof),
    Parser.terminated(Parser.alt(...skipped, record), endOfLine)
  );
};

/** Skip `n` physical lines (split on LF, like a line-oriented reader). */
const skipLines = (n: number): Parser.Parser<unknown> =>
  Parser.repeat(
    Parser.seq(Token.takeTill("\n"), Parser.alt(Parser.asVoid(Token.literal("\n")), Parser.eof)),
    n
  );

const fromSyntaxError = (e: SyntaxError.ParseError, located: boolean): ParseError => {
  const { line, column } = e.position;
  return new ParseError({
    format: "csv",
    // stream errors are positioned within the unconsumed buffer, not the source
    reason: located
      ? e.message
      : `expected ${SyntaxError.formatExpected(e.expected)}`,
    ...(located ? { position: { row: line - 1, column: column - 1 } } : {}),
    cause: e,
  });
};

// ============================================================================
// Headers and column validation
// ============================================================================

const columnCountError = (row: number, actual: number, expected: number): ParseError =>
  new ParseError({
    format: "csv",
    reason: `Row ${row} has ${actual} columns, expected ${expected}`,
    position: { row },
  });

const splitHeaders = (
  records: ReadonlyArray<ReadonlyArray<string>>,
  options: CsvScanOptions
): Effect.Effect<ScannedTable, ParseError> => {
  if (records.length === 0) return Effect.succeed({ headers: null, rows: [] });
  let headers: ReadonlyArray<string> | null = null;
  let dataStart = 0;
  if (options.treatFirstRowAsHeader) {
    headers = records[0] ?? null;
    dataStart = 1;
  } else if (options.providedHeaders) {
    headers = options.providedHeaders;
  }
  const rows = records.slice(dataStart);
  if (!options.allowVariableColumns && headers) {
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      if (row.length !== headers.length) {
        return Effect.fail(columnCountError(i + dataStart, row.length, headers.length));
      }
    }
  }
  return Effect.succeed({ headers, rows });
};

// ============================================================================
// Scanning
// ============================================================================

type TableParser = Parser.Parser<ReadonlyArray<ReadonlyArray<string> | null>>;

/** Compiled whole-text grammars, keyed by everything that shapes them. */
const tableParsers = new Map<string, TableParser>();
const maxCachedParsers = 32;

const tableParser = (dialect: CsvDialect, options: CsvScanOptions): TableParser => {
  const key = JSON.stringify([
    dialect.separator, dialect.wrapper, dialect.doubleWrapper, options.skipRows ?? 0,
    !!options.filterEmpty, !!options.trimWhitespace, options.lineCommentMarker ?? "",
  ]);
  let parser = tableParsers.get(key);
  if (parser === undefined) {
    parser = Parser.compile(
      Parser.preceded(skipLines(options.skipRows ?? 0), Parser.repeat(makeRow(dialect, options)))
    );
    if (tableParsers.size >= maxCachedParsers) tableParsers.clear();
    tableParsers.set(key, parser);
  }
  return parser;
};

/**
 * Scan CSV text into headers and raw string rows.
 */
export const scanCsv = (
  text: string,
  dialect: CsvDialect = StandardDialect,
  options?: CsvScanOptions
): Effect.Effect<ScannedTable, ParseError> => {
  const opts = defaults(options);
  const result = Parser.parse(tableParser(dialect, opts), text);
  if (Result.isFailure(result)) return Effect.fail(fromSyntaxError(result.failure, true));
  const records = result.success.filter((r): r is ReadonlyArray<string> => r !== null);
  return splitHeaders(records, opts);
};

interface HeaderState {
  /** Records seen so far, including the header row. */
  readonly index: number;
  readonly headers: ReadonlyArray<string> | null;
}

/** Drop the first `n` physical lines (split on LF) from a stream of text chunks. */
const dropLines = <E, R>(n: number) => (chunks: Stream.Stream<string, E, R>): Stream.Stream<string, E, R> =>
  n <= 0
    ? chunks
    : Stream.mapAccum(chunks, () => n, (remaining, chunk) => {
        let start = 0;
        while (remaining > 0) {
          const nl = chunk.indexOf("\n", start);
          if (nl === -1) return [remaining, []] as const;
          start = nl + 1;
          remaining--;
        }
        return [0, start === 0 ? [chunk] : [chunk.slice(start)]] as const;
      });

/**
 * Scan a stream of CSV text chunks into data rows, emitting each row as soon as
 * it is complete. Chunks may split fields, quotes and line endings anywhere.
 * With `treatFirstRowAsHeader`, the header row is used for column validation
 * and not emitted.
 */
export const scanCsvStream = <E, R>(
  chunks: Stream.Stream<string, E, R>,
  dialect: CsvDialect = StandardDialect,
  options?: CsvScanOptions
): Stream.Stream<ReadonlyArray<string>, E | ParseError, R> => {
  const opts = defaults(options);
  const row = makeRow(dialect, opts);
  return pipe(
    chunks,
    dropLines(opts.skipRows ?? 0),
    ParserStream.parseMany(row),
    Stream.mapError((e) => (SyntaxError.isParseError(e) ? fromSyntaxError(e as SyntaxError.ParseError, false) : e as E)),
    Stream.filter((r): r is ReadonlyArray<string> => r !== null),
    Stream.mapAccumEffect(
      (): HeaderState => ({ index: 0, headers: opts.treatFirstRowAsHeader ? null : opts.providedHeaders ?? null }),
      (state, fields): Effect.Effect<readonly [HeaderState, ReadonlyArray<ReadonlyArray<string>>], ParseError> => {
        const index = state.index + 1;
        if (opts.treatFirstRowAsHeader && state.index === 0) {
          return Effect.succeed([{ index, headers: fields }, []] as const);
        }
        const { headers } = state;
        if (!opts.allowVariableColumns && headers && fields.length !== headers.length) {
          return Effect.fail(columnCountError(state.index, fields.length, headers.length));
        }
        return Effect.succeed([{ index, headers }, [fields]] as const);
      }
    )
  );
};
