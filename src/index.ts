/**
 * Unified CSV toolkit using Effect
 * Single coherent API for all CSV operations
 */

import { Effect, Stream, Context, Layer, Data, pipe } from "effect";

// ============================================================================
// Core Types & Errors
// ============================================================================

export class CsvOperationError extends Data.TaggedError("CsvOperationError")<{
  readonly reason: string;
  readonly context?: Record<string, unknown>;
}> {}

/**
 * Represents tabular data - the unified data model
 */
export interface TableData {
  readonly columnHeaders: ReadonlyArray<string> | null;
  readonly dataRows: ReadonlyArray<ReadonlyArray<string>>;
}

/**
 * Dialect configuration for CSV format variations
 */
export interface CsvDialect {
  readonly separator: string;
  readonly linebreak: string;
  readonly wrapper: string;
  readonly doubleWrapper: string;
}

export const StandardDialect: CsvDialect = {
  separator: ",",
  linebreak: "\n",
  wrapper: '"',
  doubleWrapper: '""',
};

export const TsvDialect: CsvDialect = {
  separator: "\t",
  linebreak: "\n",
  wrapper: '"',
  doubleWrapper: '""',
};

// ============================================================================
// Unified CSV Service
// ============================================================================

/**
 * The main CSV service - handles all operations through a unified interface
 */
export interface Csv {
  /**
   * Read CSV text into structured table data
   */
  readonly read: (
    text: string,
    options?: ReadOptions
  ) => Effect.Effect<TableData, CsvOperationError>;

  /**
   * Write table data to CSV text
   */
  readonly write: (
    data: TableData
  ) => Effect.Effect<string, CsvOperationError>;

  /**
   * Stream table data from CSV text
   */
  readonly readStream: (
    text: string,
    options?: ReadOptions
  ) => Stream.Stream<ReadonlyArray<string>, CsvOperationError>;

  /**
   * Create synthetic table data for testing
   */
  readonly synthesize: (
    spec: SynthesisSpec
  ) => Effect.Effect<TableData, never>;
}

export const CsvTag = Context.GenericTag<Csv>("@effect-csv/Csv");

/**
 * Options for reading operations
 */
export interface ReadOptions {
  readonly treatFirstRowAsHeader?: boolean;
  readonly providedHeaders?: ReadonlyArray<string>;
  readonly skipRows?: number;
  readonly filterEmpty?: boolean;
  readonly trimWhitespace?: boolean;
  readonly allowVariableColumns?: boolean;
  readonly lineCommentMarker?: string;
}

/**
 * Specification for data synthesis
 */
export interface SynthesisSpec {
  readonly columns: ReadonlyArray<string> | number;
  readonly quantity: number;
  readonly seed?: number;
  readonly fieldLengthRange?: readonly [number, number];
}

// ============================================================================
// Implementation
// ============================================================================

const createCsvImplementation = (dialect: CsvDialect): Csv => {
  // ------------------------------------------------------------------------
  // Reading Implementation
  // ------------------------------------------------------------------------

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
    state: ScanState
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
    options: ReadOptions
  ): Effect.Effect<
    { fields: ReadonlyArray<string> | null; nextPos: number },
    CsvOperationError
  > =>
    Effect.gen(function* () {
      const lineEnd = text.indexOf("\n", startPos);
      const lineText =
        lineEnd === -1
          ? text.substring(startPos)
          : text.substring(startPos, lineEnd);

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
        scanState = yield* scanNextField(lineText, scanState);
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

  const read = (
    text: string,
    options?: ReadOptions
  ): Effect.Effect<TableData, CsvOperationError> =>
    Effect.gen(function* () {
      const opts: ReadOptions = {
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
        const result = yield* scanCompleteLine(text, position, opts);
        position = result.nextPos;

        if (result.fields !== null) {
          allRows.push([...result.fields]);
        }
      }

      if (allRows.length === 0) {
        return { columnHeaders: null, dataRows: [] };
      }

      let headers: ReadonlyArray<string> | null = null;
      let dataStart = 0;

      if (opts.treatFirstRowAsHeader) {
        headers = allRows[0] ?? null;
        dataStart = 1;
      } else if (opts.providedHeaders) {
        headers = opts.providedHeaders;
      }

      const dataRows = allRows.slice(dataStart);

      // Validate column counts if required
      if (!opts.allowVariableColumns && headers) {
        const expectedCount = headers.length;
        for (let i = 0; i < dataRows.length; i++) {
          const row = dataRows[i]!;
          if (row.length !== expectedCount) {
            yield* Effect.fail(
              new CsvOperationError({
                reason: `Row ${i + dataStart} has ${row.length} columns, expected ${expectedCount}`,
                context: { rowIndex: i + dataStart, actual: row.length, expected: expectedCount },
              })
            );
          }
        }
      }

      return { columnHeaders: headers, dataRows };
    });

  // ------------------------------------------------------------------------
  // Writing Implementation
  // ------------------------------------------------------------------------

  const fieldRequiresWrapping = (value: string): boolean => {
    return (
      value.includes(dialect.separator) ||
      value.includes(dialect.wrapper) ||
      value.includes("\n") ||
      value.includes("\r")
    );
  };

  const wrapField = (value: string): string => {
    const escaped = value
      .split(dialect.wrapper)
      .join(dialect.doubleWrapper);
    return dialect.wrapper + escaped + dialect.wrapper;
  };

  const renderField = (value: string): string => {
    if (fieldRequiresWrapping(value)) {
      return wrapField(value);
    }
    return value;
  };

  const write = (
    data: TableData
  ): Effect.Effect<string, CsvOperationError> =>
    Effect.gen(function* () {
      const lines: string[] = [];

      if (data.columnHeaders) {
        const headerLine = data.columnHeaders
          .map(renderField)
          .join(dialect.separator);
        lines.push(headerLine);
      }

      for (const row of data.dataRows) {
        const line = row.map(renderField).join(dialect.separator);
        lines.push(line);
      }

      return lines.join(dialect.linebreak) + dialect.linebreak;
    });

  // ------------------------------------------------------------------------
  // Streaming Implementation
  // ------------------------------------------------------------------------

  const readStream = (
    text: string,
    options?: ReadOptions
  ): Stream.Stream<ReadonlyArray<string>, CsvOperationError> =>
    pipe(
      read(text, options),
      Effect.map((table) => table.dataRows),
      Stream.fromIterableEffect
    );

  // ------------------------------------------------------------------------
  // Synthesis Implementation
  // ------------------------------------------------------------------------

  class SeedableRng {
    private value: number;

    constructor(seed: number) {
      this.value = seed;
    }

    next(): number {
      const multiplier = 48271;
      const modulus = 2147483647;
      this.value = (this.value * multiplier) % modulus;
      return this.value / modulus;
    }

    between(min: number, max: number): number {
      return Math.floor(this.next() * (max - min + 1)) + min;
    }
  }

  const generateRandomContent = (
    lengthRange: readonly [number, number],
    rng: SeedableRng | null
  ): Effect.Effect<string> =>
    Effect.sync(() => {
      const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
      const len = rng
        ? rng.between(lengthRange[0], lengthRange[1])
        : Math.floor(Math.random() * (lengthRange[1] - lengthRange[0] + 1)) +
          lengthRange[0];

      let result = "";
      for (let i = 0; i < len; i++) {
        const idx = rng
          ? rng.between(0, chars.length - 1)
          : Math.floor(Math.random() * chars.length);
        result += chars[idx];
      }
      return result;
    });

  const synthesize = (
    spec: SynthesisSpec
  ): Effect.Effect<TableData, never> =>
    Effect.gen(function* () {
      const rawLengthRange = spec.fieldLengthRange ?? [5, 20];
      const minRaw = rawLengthRange[0];
      const maxRaw = rawLengthRange[1];
      const lower = Math.min(minRaw, maxRaw);
      const upper = Math.max(minRaw, maxRaw);
      const min = Math.max(0, lower);
      const max = Math.max(min, upper);
      const lengthRange: readonly [number, number] = [min, max];
      const rng = spec.seed !== undefined ? new SeedableRng(spec.seed) : null;

      const columns = Array.isArray(spec.columns)
        ? spec.columns
        : Array.from({ length: spec.columns as number }, (_, i) => `col${i}`);

      const dataRows: string[][] = [];

      const rawQuantity = spec.quantity;
      const quantity =
        typeof rawQuantity === "number" && Number.isFinite(rawQuantity) && rawQuantity > 0
          ? Math.floor(rawQuantity)
          : 0;

      for (let rowIdx = 0; rowIdx < quantity; rowIdx++) {
        const row: string[] = [];
        for (let colIdx = 0; colIdx < columns.length; colIdx++) {
          const content = yield* generateRandomContent(lengthRange, rng);
          row.push(content);
        }
        dataRows.push(row);
      }

      return {
        columnHeaders: columns,
        dataRows,
      };
    });

  return { read, write, readStream, synthesize };
};

// ============================================================================
// Layer Constructors
// ============================================================================

export const CsvLive = Layer.succeed(
  CsvTag,
  createCsvImplementation(StandardDialect)
);

export const makeCsvLayer = (dialect: CsvDialect): Layer.Layer<Csv> =>
  Layer.succeed(CsvTag, createCsvImplementation(dialect));

// ============================================================================
// Convenience Functions (optional, for non-service usage)
// ============================================================================

export const csvRead = (text: string, options?: ReadOptions) =>
  pipe(
    CsvTag,
    Effect.flatMap((csv) => csv.read(text, options)),
    Effect.provide(CsvLive)
  );

export const csvWrite = (data: TableData) =>
  pipe(
    CsvTag,
    Effect.flatMap((csv) => csv.write(data)),
    Effect.provide(CsvLive)
  );

export const csvSynthesize = (spec: SynthesisSpec) =>
  pipe(
    CsvTag,
    Effect.flatMap((csv) => csv.synthesize(spec)),
    Effect.provide(CsvLive)
  );
