/**
 * The CSV Writer: a CSV-profile document -> CSV text.
 *
 * The input type (`Doc<CsvFeature>`) already guarantees a single worksheet of
 * representable cells, so the writer never has to reject anything at runtime -
 * over-rich documents are a compile error, or are narrowed by `convert` first.
 */

import { Effect, Layer } from "effect";
import { type Doc, type FeaturesOf } from "../../profile/profile.js";
import { Csv } from "../../profile/profiles.js";
import { type Worksheet, cellToText } from "../../schema/index.js";
import { text, type Content } from "../../io/content.js";
import { WriteError } from "../../io/errors.js";
import { makeWriterTag, type Writer } from "../../io/writer.js";
import { StandardDialect, type CsvDialect } from "./dialect.js";

type CsvFeature = FeaturesOf<typeof Csv>;

export interface CsvWriterOptions {
  /** The CSV dialect to render with (defaults to StandardDialect). */
  readonly dialect?: CsvDialect;
}

// ============================================================================
// Field rendering
// ============================================================================

const fieldRequiresWrapping = (value: string, dialect: CsvDialect): boolean =>
  value.includes(dialect.separator) ||
  value.includes(dialect.wrapper) ||
  value.includes("\n") ||
  value.includes("\r");

const wrapField = (value: string, dialect: CsvDialect): string =>
  dialect.wrapper + value.replaceAll(dialect.wrapper, dialect.doubleWrapper) + dialect.wrapper;

/** Render a single field, quoting it if necessary. */
export const renderField = (value: string, dialect: CsvDialect): string =>
  fieldRequiresWrapping(value, dialect) ? wrapField(value, dialect) : value;

/** Render rows of string fields to CSV text (with trailing newline). */
export const renderTable = (
  rows: ReadonlyArray<ReadonlyArray<string>>,
  dialect: CsvDialect = StandardDialect
): string =>
  rows.map((row) => row.map((f) => renderField(f, dialect)).join(dialect.separator)).join(
    dialect.linebreak
  ) + (rows.length > 0 ? dialect.linebreak : "");

// ============================================================================
// Writer
// ============================================================================

/** Create a CSV Writer with the given options baked in. */
export const makeCsvWriter = (options?: CsvWriterOptions): Writer<CsvFeature> => {
  const dialect = options?.dialect ?? StandardDialect;

  const write = (doc: Doc<CsvFeature>): Effect.Effect<Content, WriteError> =>
    Effect.sync(() => {
      const ws = doc.blocks.find((b): b is Worksheet => b._tag === "Worksheet");
      if (ws === undefined) return text("");
      const rows = ws.rows.map((row) => row.cells.map(cellToText));
      return text(renderTable(rows, dialect));
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
