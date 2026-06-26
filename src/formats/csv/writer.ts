/**
 * The CSV Writer: tabular Workbook -> CSV text.
 *
 * Implements the effect-document core Writer interface. Typed cells are
 * rendered canonically: numbers via String(), dates as ISO-8601, booleans as
 * "true"/"false", and null cells as empty fields.
 */

import { Effect, Layer } from "effect";
import {
  WriteError,
  cellToString,
  makeWriterTag,
  text,
  type Content,
  type Workbook,
  type Writer,
} from "../../core/index.js";
import { StandardDialect, type CsvDialect } from "./dialect.js";

export interface CsvWriterOptions {
  /** The CSV dialect to render with (defaults to StandardDialect) */
  readonly dialect?: CsvDialect;
  /**
   * What to do when the workbook has more than one sheet (CSV can only
   * represent one):
   * - "fail" (default): fail with a WriteError
   * - "firstOnly": write only the first sheet
   */
  readonly onMultipleSheets?: "fail" | "firstOnly";
}

// ============================================================================
// Field rendering (shared with the legacy API)
// ============================================================================

const fieldRequiresWrapping = (value: string, dialect: CsvDialect): boolean =>
  value.includes(dialect.separator) ||
  value.includes(dialect.wrapper) ||
  value.includes("\n") ||
  value.includes("\r");

const wrapField = (value: string, dialect: CsvDialect): string => {
  const escaped = value.replaceAll(dialect.wrapper, dialect.doubleWrapper);
  return dialect.wrapper + escaped + dialect.wrapper;
};

/** Render a single field, quoting it if necessary */
export const renderField = (value: string, dialect: CsvDialect): string =>
  fieldRequiresWrapping(value, dialect) ? wrapField(value, dialect) : value;

/**
 * Render optional headers plus rows of string fields to CSV text
 * (with trailing newline).
 */
export const renderTable = (
  headers: ReadonlyArray<string> | null,
  rows: ReadonlyArray<ReadonlyArray<string>>,
  dialect: CsvDialect = StandardDialect
): string => {
  const lines: string[] = [];

  if (headers) {
    lines.push(headers.map((h) => renderField(h, dialect)).join(dialect.separator));
  }

  for (const row of rows) {
    lines.push(row.map((f) => renderField(f, dialect)).join(dialect.separator));
  }

  return lines.join(dialect.linebreak) + dialect.linebreak;
};

// ============================================================================
// Writer
// ============================================================================

/**
 * Create a CSV Writer with the given options baked in.
 */
export const makeCsvWriter = (options?: CsvWriterOptions): Writer => {
  const dialect = options?.dialect ?? StandardDialect;
  const onMultipleSheets = options?.onMultipleSheets ?? "fail";

  const writeWorkbook = (
    workbook: Workbook
  ): Effect.Effect<Content, WriteError> =>
    Effect.gen(function* () {
      if (workbook.sheets.length > 1 && onMultipleSheets === "fail") {
        return yield* new WriteError({
          format: "csv",
          reason: `CSV cannot represent a workbook with ${workbook.sheets.length} sheets; pass onMultipleSheets: "firstOnly" to write just the first sheet`,
        });
      }

      const sheet = workbook.sheets[0];
      const rows = sheet.rows.map((row) => row.map(cellToString));

      return text(renderTable(sheet.headers, rows, dialect));
    });

  return {
    format: "csv",
    writeWorkbook,
  };
};

/** Context tag for dependency-injection style usage */
export const CsvWriterTag = makeWriterTag("csv");

/** Layer providing a CSV Writer with default options */
export const CsvWriterLive = Layer.succeed(CsvWriterTag, makeCsvWriter());

/** Layer providing a CSV Writer with custom options */
export const makeCsvWriterLayer = (options?: CsvWriterOptions) =>
  Layer.succeed(CsvWriterTag, makeCsvWriter(options));
