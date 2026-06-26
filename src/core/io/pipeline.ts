/**
 * The conversion pipeline - the equivalent of `pandoc -f <from> -t <to>`.
 *
 * Reads source content with the `from` format's reader, bridges between the
 * tabular and document IR layers if the reader and writer disagree, and
 * renders with the `to` format's writer.
 */

import { Effect } from "effect";
import { documentToWorkbook, workbookToDocument } from "../convert/bridge.js";
import { ConversionError, type ParseError, type WriteError } from "../errors.js";
import type { Content } from "./content.js";
import type { Format } from "./format.js";

export interface ConvertOptions {
  /** Source format */
  readonly from: Format;
  /** Target format */
  readonly to: Format;
  /** Source content */
  readonly input: Content;
}

export type ConvertError = ParseError | WriteError | ConversionError;

/**
 * Convert content from one format to another.
 *
 * ```ts
 * const xlsxBytes = yield* convert({
 *   from: Csv.format,
 *   to: Xlsx.format,
 *   input: text("a,b\n1,2"),
 * })
 * ```
 */
export const convert = ({
  from,
  to,
  input,
}: ConvertOptions): Effect.Effect<Content, ConvertError> =>
  Effect.gen(function* () {
    const reader = from.reader;
    if (reader === undefined) {
      return yield* new ConversionError({
        reason: `Format "${from.id}" does not support reading`,
      });
    }

    const writer = to.writer;
    if (writer === undefined) {
      return yield* new ConversionError({
        reason: `Format "${to.id}" does not support writing`,
      });
    }

    // Prefer paths that avoid lossy bridging between IR layers.
    if (reader.readWorkbook && writer.writeWorkbook) {
      const workbook = yield* reader.readWorkbook(input);
      return yield* writer.writeWorkbook(workbook);
    }

    if (reader.readDocument && writer.writeDocument) {
      const document = yield* reader.readDocument(input);
      return yield* writer.writeDocument(document);
    }

    if (reader.readWorkbook && writer.writeDocument) {
      const workbook = yield* reader.readWorkbook(input);
      const document = yield* workbookToDocument(workbook);
      return yield* writer.writeDocument(document);
    }

    if (reader.readDocument && writer.writeWorkbook) {
      const document = yield* reader.readDocument(input);
      const workbook = yield* documentToWorkbook(document);
      return yield* writer.writeWorkbook(workbook);
    }

    return yield* new ConversionError({
      reason: `No conversion path from "${from.id}" to "${to.id}": the reader and writer expose no compatible IR layer`,
    });
  });
