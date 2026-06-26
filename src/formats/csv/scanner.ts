/**
 * The low-level CSV scanner: text -> rows of raw string fields.
 *
 * Handles quoting, escaped quotes, comments, row skipping, whitespace
 * trimming, and column-count validation, parameterized by dialect.
 */

import { Effect } from "effect";
import { ParseError } from "../../core/index.js";
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

interface ScanState {
  position: number;
  buffer: string;
  insideWrapper: boolean;
  fields: string[];
}

const initScanState = (): ScanState => ({
  position: 0,
  buffer: "",
  insideWrapper: false,
  fields: [],
});

const finalizeField = (state: ScanState): ScanState => ({
  ...state,
  fields: [...state.fields, state.buffer],
  buffer: "",
});

const scanNextField = (
  text: string,
  state: ScanState,
  dialect: CsvDialect
): Effect.Effect<ScanState, never> =>
  Effect.sync(() => {
    let current = state;

    while (current.position < text.length) {
      const char = text[current.position]!;
      const ahead = text.substring(
        current.position,
        current.position + dialect.wrapper.length
      );
      const doubleAhead = text.substring(
        current.position,
        current.position + dialect.doubleWrapper.length
      );

      if (current.insideWrapper) {
        if (doubleAhead === dialect.doubleWrapper) {
          current = {
            ...current,
            buffer: current.buffer + dialect.wrapper,
            position: current.position + dialect.doubleWrapper.length,
          };
        } else if (ahead === dialect.wrapper) {
          current = {
            ...current,
            insideWrapper: false,
            position: current.position + dialect.wrapper.length,
          };
        } else {
          current = {
            ...current,
            buffer: current.buffer + char,
            position: current.position + 1,
          };
        }
      } else {
        if (ahead === dialect.wrapper) {
          current = {
            ...current,
            insideWrapper: true,
            position: current.position + dialect.wrapper.length,
          };
        } else if (char === dialect.separator) {
          current = finalizeField(current);
          current = { ...current, position: current.position + 1 };
          break;
        } else if (char === "\n" || char === "\r") {
          break;
        } else {
          current = {
            ...current,
            buffer: current.buffer + char,
            position: current.position + 1,
          };
        }
      }
    }

    return current;
  });

const scanCompleteLine = (
  text: string,
  startPos: number,
  dialect: CsvDialect,
  options: CsvScanOptions
): Effect.Effect<
  { fields: ReadonlyArray<string> | null; nextPos: number },
  ParseError
> =>
  Effect.gen(function* () {
    const lineEnd = text.indexOf("\n", startPos);
    const rawLineText =
      lineEnd === -1 ? text.substring(startPos) : text.substring(startPos, lineEnd);
    const lineText = rawLineText.endsWith("\r")
      ? rawLineText.slice(0, -1)
      : rawLineText;

    if (options.filterEmpty && lineText.trim() === "") {
      return {
        fields: null,
        nextPos: lineEnd === -1 ? text.length : lineEnd + 1,
      };
    }

    if (
      options.lineCommentMarker &&
      lineText.trimStart().startsWith(options.lineCommentMarker)
    ) {
      return {
        fields: null,
        nextPos: lineEnd === -1 ? text.length : lineEnd + 1,
      };
    }

    let scanState = initScanState();
    while (scanState.position < lineText.length) {
      scanState = yield* scanNextField(lineText, scanState, dialect);
    }

    const allFields = [...scanState.fields, scanState.buffer];
    const processed = options.trimWhitespace
      ? allFields.map((f) => f.trim())
      : allFields;

    return {
      fields: processed,
      nextPos: lineEnd === -1 ? text.length : lineEnd + 1,
    };
  });

/**
 * Scan CSV text into headers and raw string rows.
 */
export const scanCsv = (
  text: string,
  dialect: CsvDialect = StandardDialect,
  options?: CsvScanOptions
): Effect.Effect<ScannedTable, ParseError> =>
  Effect.gen(function* () {
    const opts: CsvScanOptions = {
      treatFirstRowAsHeader: false,
      skipRows: 0,
      filterEmpty: true,
      trimWhitespace: false,
      allowVariableColumns: false,
      ...options,
    };

    let position = 0;
    const allRows: string[][] = [];

    // Skip initial rows
    for (let i = 0; i < (opts.skipRows ?? 0); i++) {
      const newlinePos = text.indexOf("\n", position);
      position = newlinePos === -1 ? text.length : newlinePos + 1;
    }

    // Scan all lines
    while (position < text.length) {
      const result = yield* scanCompleteLine(text, position, dialect, opts);
      position = result.nextPos;

      if (result.fields !== null) {
        allRows.push([...result.fields]);
      }
    }

    if (allRows.length === 0) {
      return { headers: null, rows: [] };
    }

    let headers: ReadonlyArray<string> | null = null;
    let dataStart = 0;

    if (opts.treatFirstRowAsHeader) {
      headers = allRows[0] ?? null;
      dataStart = 1;
    } else if (opts.providedHeaders) {
      headers = opts.providedHeaders;
    }

    const rows = allRows.slice(dataStart);

    // Validate column counts if required
    if (!opts.allowVariableColumns && headers) {
      const expectedCount = headers.length;
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i]!;
        if (row.length !== expectedCount) {
          yield* Effect.fail(
            new ParseError({
              format: "csv",
              reason: `Row ${i + dataStart} has ${row.length} columns, expected ${expectedCount}`,
              position: { row: i + dataStart },
            })
          );
        }
      }
    }

    return { headers, rows };
  });
