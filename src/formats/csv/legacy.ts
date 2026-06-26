/**
 * The legacy effect-csv API, preserved for backwards compatibility.
 *
 * This is the original unified `Csv` service interface from effect-csv
 * v0.1.x, now implemented on top of the effect-document CSV internals.
 * New code should prefer the Reader/Writer API from the package root.
 */

import { Context, Data, Effect, Layer, Stream, pipe } from "effect";
import { scanCsv, type CsvScanOptions } from "./scanner.js";
import { renderTable } from "./writer.js";
import { synthesizeTable, type SynthesisSpec } from "./synthesize.js";
import { StandardDialect, TsvDialect, type CsvDialect } from "./dialect.js";

export { StandardDialect, TsvDialect };
export type { CsvDialect, SynthesisSpec };

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
 * Options for reading operations
 */
export type ReadOptions = CsvScanOptions;

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
  readonly write: (data: TableData) => Effect.Effect<string, CsvOperationError>;

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

const createCsvImplementation = (dialect: CsvDialect): Csv => {
  const read = (
    text: string,
    options?: ReadOptions
  ): Effect.Effect<TableData, CsvOperationError> =>
    pipe(
      scanCsv(text, dialect, options),
      Effect.map(({ headers, rows }) => ({
        columnHeaders: headers,
        dataRows: rows,
      })),
      Effect.mapError(
        (error) =>
          new CsvOperationError({
            reason: error.reason,
            context: { position: error.position },
          })
      )
    );

  const write = (data: TableData): Effect.Effect<string, CsvOperationError> =>
    Effect.sync(() => renderTable(data.columnHeaders, data.dataRows, dialect));

  const readStream = (
    text: string,
    options?: ReadOptions
  ): Stream.Stream<ReadonlyArray<string>, CsvOperationError> =>
    pipe(
      read(text, options),
      Effect.map((table) => table.dataRows),
      Stream.fromIterableEffect
    );

  const synthesize = (spec: SynthesisSpec): Effect.Effect<TableData, never> =>
    Effect.map(synthesizeTable(spec), ({ headers, rows }) => ({
      columnHeaders: headers,
      dataRows: rows,
    }));

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

export const csvReadStream = (text: string, options?: ReadOptions) =>
  pipe(
    CsvTag,
    Effect.map((csv) => csv.readStream(text, options)),
    Effect.provide(CsvLive),
    Stream.unwrap
  );
